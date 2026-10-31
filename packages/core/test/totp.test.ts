import { expect, it } from 'vitest';
import { base32Decode, base32Encode, newTotpSecret, otpauthUri, totpAt, totpStep, verifyTotp } from '../src/totp.ts';

// RFC 6238 Appendix B, SHA-1 secret "12345678901234567890" (8-digit codes; we use the last 6).
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));

it('matches the RFC 6238 test vectors', async () => {
	const vectors: [number, string][] = [
		[59, '94287082'],
		[1111111109, '07081804'],
		[1111111111, '14050471'],
		[1234567890, '89005924'],
		[2000000000, '69279037'],
	];
	for (const [t, code] of vectors) expect(await totpAt(RFC_SECRET, Math.floor(t / 30), 8)).toBe(code);
	expect(await totpAt(RFC_SECRET, Math.floor(59 / 30))).toBe('287082');
});

it('base32 round-trips', () => {
	const b = crypto.getRandomValues(new Uint8Array(20));
	expect([...base32Decode(base32Encode(b))]).toEqual([...b]);
	expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
});

it('verifies with ±1 step of drift and refuses reused steps', async () => {
	const s = newTotpSecret();
	const now = 1_800_000_000_000;
	const code = await totpAt(s, totpStep(now) - 1);
	const step = await verifyTotp(s, code, now);
	expect(step).toBe(totpStep(now) - 1);
	expect(await verifyTotp(s, code, now, step)).toBeNull(); // replay
	expect(await verifyTotp(s, await totpAt(s, totpStep(now) - 2), now)).toBeNull(); // too old
	expect(await verifyTotp(s, '12345', now)).toBeNull();
	expect(otpauthUri(s, 'a@b.co')).toBe(`otpauth://totp/AutoConfirm:a%40b.co?secret=${s}&issuer=AutoConfirm&algorithm=SHA1&digits=6&period=30`);
});
