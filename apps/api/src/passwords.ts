// Dashboard passwords: PBKDF2-SHA256 with a random salt. 100,000 iterations is the most Cloudflare
// Workers allows; owners and admins also need a TOTP code (SECURITY.md T10).
import { timingSafeEqual } from '@autoconfirm/core';

const ITERATIONS = 100_000;
const enc = new TextEncoder();

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return `pbkdf2_sha256$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

/** Constant-time check. A null/unknown hash still does the work, so timing doesn't reveal unknown emails. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
	const parts = (stored ?? '').split('$');
	const valid = parts.length === 4 && parts[0] === 'pbkdf2_sha256';
	const iterations = valid ? Math.min(Number(parts[1]), ITERATIONS) : ITERATIONS;
	const salt = valid ? unb64(parts[2]!) : new Uint8Array(16);
	const got = b64(await derive(password, new Uint8Array(salt), iterations));
	return valid && timingSafeEqual(got, parts[3]!);
}

export const PASSWORD_MIN = 10;
