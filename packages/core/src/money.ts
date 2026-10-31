// Money is integer paise everywhere. Never use floating point.

const RUPEES = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

/** Parse a rupee string like "930.07", "1,250.5" or "₹ 99" into integer paise. Returns null if invalid. */
export function parseRupeesToPaise(input: string): number | null {
	const cleaned = input.replace(/[₹\s,]/g, '').replace(/^Rs\.?/i, '').replace(/^INR/i, '');
	const m = RUPEES.exec(cleaned);
	if (!m) return null;
	const rupees = Number(m[1]);
	const frac = (m[2] ?? '').padEnd(2, '0'); // "7" -> "70" ("930.7" is 93070 paise)
	return rupees * 100 + Number(frac);
}

/** 93007 -> "930.07" */
export function formatPaise(paise: number): string {
	assertPaise(paise);
	const rupees = Math.floor(paise / 100);
	const rest = paise % 100;
	return `${rupees}.${rest.toString().padStart(2, '0')}`;
}

export function isPaise(n: unknown): n is number {
	return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

export function assertPaise(n: unknown): asserts n is number {
	if (!isPaise(n)) throw new TypeError(`not an integer paise amount: ${String(n)}`);
}
