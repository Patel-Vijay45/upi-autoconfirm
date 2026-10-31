import { formatPaise } from './money.ts';

export interface UpiPayee {
	vpa: string; // merchant's own UPI ID
	payeeName: string;
}

export interface UpiLinks {
	uri: string;
	apps: { gpay: string; phonepe: string; paytm: string };
}

/** Standard UPI deep links. `tr` = intent id, `tn` = short note (order label). */
export function buildUpiLinks(payee: UpiPayee, uniqueAmount: number, intentId: string, note?: string): UpiLinks {
	const params = new URLSearchParams();
	params.set('pa', payee.vpa);
	params.set('pn', payee.payeeName);
	params.set('am', formatPaise(uniqueAmount));
	params.set('cu', 'INR');
	if (note) params.set('tn', note.slice(0, 50));
	params.set('tr', intentId);
	// URLSearchParams encodes spaces as '+' and '@' as %40; UPI apps expect %20 and a literal '@'.
	const q = params.toString().replace(/\+/g, '%20').replace(/%40/g, '@');
	return {
		uri: `upi://pay?${q}`,
		apps: {
			gpay: `gpay://upi/pay?${q}`,
			phonepe: `phonepe://pay?${q}`,
			paytm: `paytmmp://pay?${q}`,
		},
	};
}
