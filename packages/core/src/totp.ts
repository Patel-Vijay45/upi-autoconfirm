// TOTP (RFC 6238, HMAC-SHA1, 30 s, 6 digits): the codes from Google Authenticator and similar apps.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(s: string): Uint8Array<ArrayBuffer> {
	const clean = s.toUpperCase().replace(/[\s=-]/g, '');
	const out: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of clean) {
		const v = B32.indexOf(ch);
		if (v < 0) throw new Error('invalid base32');
		value = (value << 5) | v;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

/** A new random TOTP secret (160 bits), base32. */
export function newTotpSecret(): string {
	return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export async function totpAt(secretB32: string, step: number, digits = 6): Promise<string> {
	const key = await crypto.subtle.importKey('raw', base32Decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	const msg = new Uint8Array(8);
	let s = step;
	for (let i = 7; i >= 0; i--) {
		msg[i] = s & 0xff;
		s = Math.floor(s / 256);
	}
	const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
	const off = h[h.length - 1]! & 0xf;
	const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
	return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / 30);

/**
 * Checks a code against the current step ±1 (clock drift). Returns the matching step so the caller can
 * refuse reuse (a step must be greater than the last one used), or null.
 */
export async function verifyTotp(secretB32: string, code: string, nowMs: number, lastUsedStep: number | null = null): Promise<number | null> {
	if (!/^\d{6}$/.test(code)) return null;
	const now = totpStep(nowMs);
	for (const step of [now - 1, now, now + 1]) {
		if (lastUsedStep !== null && step <= lastUsedStep) continue;
		if ((await totpAt(secretB32, step)) === code) return step;
	}
	return null;
}

export function otpauthUri(secretB32: string, account: string, issuer = 'AutoConfirm'): string {
	return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
