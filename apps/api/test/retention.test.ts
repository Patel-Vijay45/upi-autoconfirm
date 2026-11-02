import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { isRetentionSlot, runRetention } from '../src/retention.ts';
import { call, createIntent, sendSignal, setup } from './helpers.ts';

const DAY = 86_400_000;

describe('daily data clean-up', () => {
	it('runs once a day at 03:45 IST', () => {
		expect(isRetentionSlot(Date.UTC(2026, 10, 1, 22, 15))).toBe(true);
		expect(isRetentionSlot(Date.UTC(2026, 10, 1, 22, 10))).toBe(false);
		expect(isRetentionSlot(Date.UTC(2026, 10, 1, 22, 20))).toBe(false);
		expect(isRetentionSlot(Date.UTC(2026, 10, 1, 10, 15))).toBe(false);
	});

	it('blanks old personal details but keeps the payment records', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk, { customer: { name: 'Asha', phone: '+919800000000' } })).json;
		await sendSignal(device, pi.unique_amount, { payer_short: 'Ramesh P', reference: '123456789012' });
		const now = Date.now();
		const later = now + 400 * DAY; // pretend a bit more than a year has passed
		await runRetention(env, later);
		const sig = await env.DB.prepare('SELECT status, payer_name, reference FROM signals WHERE merchant_id = ?').bind(keys.merchantId).first<{ status: string; payer_name: string | null; reference: string | null }>();
		expect(sig).toEqual({ status: 'matched', payer_name: null, reference: null });
		const row = await env.DB.prepare('SELECT status, customer_name, customer_phone, unique_amount FROM payment_intents WHERE id = ?').bind(pi.id).first();
		expect(row).toEqual({ status: 'paid', customer_name: null, customer_phone: null, unique_amount: pi.unique_amount });
		expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE merchant_id = ?').bind(keys.merchantId).first<{ n: number }>())!.n).toBe(0);
		// Reports still work on the kept records.
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk })).json.status).toBe('paid');
	});

	it('keeps recent data untouched', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk, { customer: { name: 'Asha' } })).json;
		await sendSignal(device, pi.unique_amount, { payer_short: 'Ramesh P' });
		await runRetention(env, Date.now() + 10 * DAY);
		const sig = await env.DB.prepare('SELECT payer_name FROM signals WHERE merchant_id = ?').bind(keys.merchantId).first<{ payer_name: string }>();
		expect(sig!.payer_name).toBe('Ramesh P');
		const row = await env.DB.prepare('SELECT customer_name FROM payment_intents WHERE id = ?').bind(pi.id).first<{ customer_name: string }>();
		expect(row!.customer_name).toBe('Asha');
		expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE merchant_id = ?').bind(keys.merchantId).first<{ n: number }>())!.n).toBeGreaterThan(0);
	});
});
