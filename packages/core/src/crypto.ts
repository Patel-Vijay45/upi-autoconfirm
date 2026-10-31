// Small Web Crypto helpers (work in Cloudflare Workers, Node 20+, Deno, Bun).
const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let s = '';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
	const bytes = typeof data === 'string' ? enc.encode(data) : data;
	return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Constant-time string compare (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function b64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function aesKey(masterKeyB64: string): Promise<CryptoKey> {
	const raw = unb64(masterKeyB64);
	if (raw.length !== 32) throw new Error('master key must be 32 bytes (base64)');
	return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** AES-256-GCM encrypt. Output: base64(iv).base64(ciphertext) */
export async function encryptSecret(masterKeyB64: string, plaintext: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(masterKeyB64), enc.encode(plaintext));
	return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decryptSecret(masterKeyB64: string, sealed: string): Promise<string> {
	const [ivB64, ctB64] = sealed.split('.');
	if (!ivB64 || !ctB64) throw new Error('bad sealed secret');
	const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, await aesKey(masterKeyB64), unb64(ctB64));
	return new TextDecoder().decode(pt);
}
