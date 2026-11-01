// Web Push (no libraries): VAPID JWT (RFC 8292) and aes128gcm payload encryption (RFC 8291 / RFC 8188).
// Used to send phone-offline and inbox alerts to the dashboard users' browsers. Web Crypto only.

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array<ArrayBuffer> {
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) (out.set(p, o), (o += p.length));
	return out;
}

/** A new VAPID key pair: the private key as a JWK JSON string (keep secret), the public key as base64url (65 raw bytes). */
export async function generateVapidKeys(): Promise<{ privateJwk: string; publicKey: string }> {
	const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
	return { privateJwk: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }), publicKey: vapidPublicKey(JSON.stringify(jwk)) };
}

/** The public key (what browsers pass as applicationServerKey) for a private JWK. */
export function vapidPublicKey(privateJwk: string): string {
	const j = JSON.parse(privateJwk) as { x: string; y: string };
	return b64url(concat(new Uint8Array([4]), unb64url(j.x), unb64url(j.y)));
}

/** `Authorization` header value for a push to `endpoint`. Valid 12 h. */
export async function vapidAuthorization(privateJwk: string, endpoint: string, subject: string, now = Date.now()): Promise<string> {
	const jwk = JSON.parse(privateJwk) as JsonWebKey;
	const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'], ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
	const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
	const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
	return `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapidPublicKey(privateJwk)}`;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, infoBytes: Uint8Array, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
	const info = new Uint8Array(infoBytes); // a copy on a plain ArrayBuffer (TextEncoder's type is wider)
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/**
 * Encrypt a push message for one browser subscription (its `p256dh` and `auth` keys, base64url).
 * Returns the request body (Content-Encoding: aes128gcm). `serverKeys`/`salt` are only for tests.
 */
export async function encryptPush(
	p256dh: string,
	auth: string,
	plaintext: string,
	test?: { serverKeys: CryptoKeyPair; salt: Uint8Array<ArrayBuffer> },
): Promise<Uint8Array<ArrayBuffer>> {
	const uaPublic = unb64url(p256dh);
	const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const as = test?.serverKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
	const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', as.publicKey)) as ArrayBuffer);
	// Cloudflare's types call the ECDH `public` field `$public`; the runtime takes the standard name.
	const ecdh = { name: 'ECDH', public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
	const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, as.privateKey, 256));
	const ikm = await hkdf(unb64url(auth), shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
	const salt: Uint8Array<ArrayBuffer> = test?.salt ?? crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
	const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
	const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
	const padded = concat(enc.encode(plaintext), new Uint8Array([2])); // 0x02: last (and only) record
	const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));
	const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
	return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** Push services we send to. Anything else is refused, so a subscription can't make us call arbitrary URLs. */
export function isPushEndpoint(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:' || u.port !== '') return false;
	const h = u.hostname;
	return (
		h === 'fcm.googleapis.com' ||
		h === 'updates.push.services.mozilla.com' ||
		h.endsWith('.push.services.mozilla.com') ||
		h === 'web.push.apple.com' ||
		h.endsWith('.push.apple.com') ||
		h.endsWith('.notify.windows.com')
	);
}
