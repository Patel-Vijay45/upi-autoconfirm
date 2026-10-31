// QR codes for UPI links, drawn on the server so browsers need no QR library.
import { encode } from 'uqr';

/** Boolean module matrix (true = dark), without quiet zone. Error correction M. */
export function qrMatrix(text: string): boolean[][] {
	return encode(text, { ecc: 'M', border: 0 }).data;
}

/** Compact SVG: one path of horizontal runs, white background, 4-module quiet zone. */
export function qrSvg(text: string, opts: { quietZone?: number; label?: string } = {}): string {
	const m = qrMatrix(text);
	const q = opts.quietZone ?? 4;
	const n = m.length + q * 2;
	let d = '';
	for (let y = 0; y < m.length; y++) {
		const row = m[y]!;
		let x = 0;
		while (x < row.length) {
			if (!row[x]) {
				x++;
				continue;
			}
			let w = 1;
			while (x + w < row.length && row[x + w]) w++;
			d += `M${x + q} ${y + q}h${w}v1h-${w}z`;
			x += w;
		}
	}
	const label = (opts.label ?? 'UPI payment QR code').replace(/[<>&"]/g, '');
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${label}">` +
		`<rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`
	);
}
