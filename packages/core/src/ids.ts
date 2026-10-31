// Unguessable ids: prefix + 20 base32 chars = 100 bits of randomness.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function randomId(prefix: string, length = 20): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = '';
	for (const b of bytes) out += ALPHABET[b & 31];
	return `${prefix}_${out}`;
}

/** Uniform random integer in [0, maxExclusive) using rejection sampling. */
export function randomInt(maxExclusive: number): number {
	if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
		throw new RangeError('maxExclusive must be an integer in (0, 2^32]');
	}
	const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive;
	const buf = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(buf);
		const v = buf[0]!;
		if (v < limit) return v % maxExclusive;
	}
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Random secret token: `bytes` random bytes encoded as base62 (32 bytes -> ~43 chars). */
export function randomSecret(bytes = 32): string {
	const raw = crypto.getRandomValues(new Uint8Array(bytes));
	let n = 0n;
	for (const b of raw) n = (n << 8n) | BigInt(b);
	let out = '';
	while (n > 0n) {
		out = BASE62[Number(n % 62n)] + out;
		n /= 62n;
	}
	return out.padStart(Math.ceil((bytes * 8) / Math.log2(62)), '0');
}
