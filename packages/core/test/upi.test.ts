import { expect, it } from 'vitest';
import { buildUpiLinks } from '../src/upi.ts';

it('builds UPI links with paise amount and %20 spaces', () => {
	const l = buildUpiLinks({ vpa: 'shop@ybl', payeeName: 'My Shop' }, 93007, 'pi_abc', 'ORD-1042');
	expect(l.uri).toBe('upi://pay?pa=shop@ybl&pn=My%20Shop&am=930.07&cu=INR&tn=ORD-1042&tr=pi_abc');
	expect(l.apps.gpay.startsWith('gpay://upi/pay?pa=shop@ybl')).toBe(true);
	expect(l.apps.phonepe.startsWith('phonepe://pay?')).toBe(true);
	expect(l.apps.paytm.startsWith('paytmmp://pay?')).toBe(true);
});
