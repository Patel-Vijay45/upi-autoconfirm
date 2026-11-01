import { describe, expect, it } from 'vitest';
import { b64url, encryptPush, generateVapidKeys, isPushEndpoint, unb64url, vapidAuthorization, vapidPublicKey } from '../src/webpush.ts';

const enc = new TextEncoder();

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: string | Uint8Array<ArrayBuffer>, bytes: number) {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	const i = typeof info === 'string' ? enc.encode(info) : info;
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: i }, key, bytes * 8));
}

/** What the browser does (RFC 8291 §3.4): decrypt with its own private key and auth secret. */
async function browserDecrypt(body: Uint8Array<ArrayBuffer>, ua: CryptoKeyPair, auth: Uint8Array<ArrayBuffer>) {
	const salt = body.slice(0, 16);
	const idlen = body[20]!;
	const asPublic = body.slice(21, 21 + idlen);
	const cipher = body.slice(21 + idlen);
	const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
	const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
	const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
	const ikm = await hkdf(auth, shared, info, 32);
	const cek = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
	const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);
	const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
	const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
	expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
	return new TextDecoder().decode(plain.slice(0, -1));
}

describe('web push', () => {
	it('encrypts a message the browser can decrypt (aes128gcm)', async () => {
		const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
		const auth = crypto.getRandomValues(new Uint8Array(16));
		const p256dh = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey)));
		const msg = JSON.stringify({ title: 'Phone offline: Counter phone', url: '/locations' });
		const body = await encryptPush(p256dh, b64url(auth), msg);
		expect(Array.from(body.slice(16, 20))).toEqual([0, 0, 16, 0]); // record size 4096
		expect(body[20]).toBe(65);
		expect(await browserDecrypt(body, ua, auth)).toBe(msg);
		// A fresh key and salt every time: the same message never encrypts the same way.
		expect(b64url(await encryptPush(p256dh, b64url(auth), msg))).not.toBe(b64url(body));
	});

	it('signs a VAPID token the push service can verify', async () => {
		const { privateJwk, publicKey } = await generateVapidKeys();
		expect(unb64url(publicKey)).toHaveLength(65);
		expect(vapidPublicKey(privateJwk)).toBe(publicKey);
		const now = 1_800_000_000_000;
		const h = await vapidAuthorization(privateJwk, 'https://fcm.googleapis.com/fcm/send/abc', 'https://dash.example.com', now);
		const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
		expect(m[4]).toBe(publicKey);
		expect(JSON.parse(new TextDecoder().decode(unb64url(m[2]!)))).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 43200, sub: 'https://dash.example.com' });
		const pub = await crypto.subtle.importKey('raw', unb64url(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
		const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(m[3]!), enc.encode(`${m[1]}.${m[2]}`));
		expect(ok).toBe(true);
	});

	it('only sends to known push services', () => {
		expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
		expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
		expect(isPushEndpoint('https://web.push.apple.com/x')).toBe(true);
		expect(isPushEndpoint('https://evil.example.com/fcm.googleapis.com')).toBe(false);
		expect(isPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
		expect(isPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
		expect(isPushEndpoint('https://fcm.googleapis.com.evil.com/x')).toBe(false);
		expect(isPushEndpoint('not a url')).toBe(false);
	});

	it('matches the RFC 8291 Appendix A example byte for byte', async () => {
		const asPub = unb64url('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
		const jwk = { kty: 'EC', crv: 'P-256', x: b64url(asPub.slice(1, 33)), y: b64url(asPub.slice(33)), d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', ext: true };
		const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
		const publicKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
		const body = await encryptPush('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', 'When I grow up, I want to be a watermelon', { serverKeys: { privateKey, publicKey }, salt: unb64url('DGv6ra1nlYgDCS1FRnbzlw') });
		expect(b64url(body)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
	});
});
