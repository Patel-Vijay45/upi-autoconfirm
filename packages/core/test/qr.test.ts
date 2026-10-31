import { expect, it } from 'vitest';
import jsQR from 'jsqr';
import { qrMatrix, qrSvg } from '../src/qr.ts';
import { buildUpiLinks } from '../src/upi.ts';

/** Render the matrix to pixels (with quiet zone) and decode it like a phone camera would. */
function decode(text: string): string | undefined {
	const m = qrMatrix(text);
	const scale = 4;
	const q = 4;
	const n = (m.length + q * 2) * scale;
	const px = new Uint8ClampedArray(n * n * 4).fill(255);
	m.forEach((row, y) =>
		row.forEach((dark, x) => {
			if (!dark) return;
			for (let dy = 0; dy < scale; dy++)
				for (let dx = 0; dx < scale; dx++) {
					const i = (((y + q) * scale + dy) * n + (x + q) * scale + dx) * 4;
					px[i] = px[i + 1] = px[i + 2] = 0;
				}
		}),
	);
	return jsQR(px, n, n)?.data;
}

it('UPI QR codes decode back to the exact link', () => {
	const links = buildUpiLinks({ vpa: 'shop@ybl', payeeName: 'My Shop & Café' }, 93007, 'pi_abcdefghijklmnopqrst', 'ORD-1042');
	expect(decode(links.uri)).toBe(links.uri);
	const long = buildUpiLinks({ vpa: 'a.very.long.merchant.name.123@okhdfcbank', payeeName: 'A'.repeat(60) }, 10_000_000, 'pi_' + 'z'.repeat(20), 'X'.repeat(50));
	expect(decode(long.uri)).toBe(long.uri);
});

it('renders a compact, self-contained SVG', () => {
	const svg = qrSvg('upi://pay?pa=shop@ybl&am=930.07');
	expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
	expect(svg).toContain('<path fill="#000" d="M');
	expect(svg).not.toMatch(/<script|on\w+=/i);
	expect(svg.length).toBeLessThan(6000);
});
