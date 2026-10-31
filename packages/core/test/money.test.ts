import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatPaise, parseRupeesToPaise } from '../src/money.ts';

describe('money', () => {
	it('parses rupee strings to integer paise without floats', () => {
		expect(parseRupeesToPaise('930.07')).toBe(93007);
		expect(parseRupeesToPaise('930.7')).toBe(93070);
		expect(parseRupeesToPaise('930')).toBe(93000);
		expect(parseRupeesToPaise('₹ 1,250.50')).toBe(125050);
		expect(parseRupeesToPaise('Rs. 99')).toBe(9900);
		expect(parseRupeesToPaise('0.29')).toBe(29); // 0.29 * 100 = 28.999999999999996 in floats
	});

	it('rejects bad input', () => {
		for (const bad of ['', 'abc', '1.234', '-5', '1e3', '12.', '.5']) expect(parseRupeesToPaise(bad)).toBeNull();
	});

	it('formats paise', () => {
		expect(formatPaise(93007)).toBe('930.07');
		expect(formatPaise(5)).toBe('0.05');
		expect(formatPaise(100)).toBe('1.00');
		expect(() => formatPaise(1.5)).toThrow();
	});

	it('round-trips every amount', () => {
		fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000_00 }), (p) => parseRupeesToPaise(formatPaise(p)) === p));
	});
});
