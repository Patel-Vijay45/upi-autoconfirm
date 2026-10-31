import { describe, expect, it, vi } from 'vitest';
import { signWebhook } from '../../core/src/signatures.ts';
import { AutoConfirm, AutoConfirmError, SignatureVerificationError } from '../src/index.ts';

const SK = 'sk_test_' + 'a'.repeat(43);

function fakeFetch(...responses: (Response | Error)[]) {
	return vi.fn(async () => {
		const r = responses.shift();
		if (!r) throw new Error('no more responses');
		if (r instanceof Error) throw r;
		return r;
	});
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AutoConfirm client', () => {
	it('creates an intent with the secret key and Idempotency-Key', async () => {
		const f = fakeFetch(json(201, { id: 'pi_1', unique_amount: 93007 }));
		const ac = new AutoConfirm(SK, { baseUrl: 'https://api.example.com/', fetch: f as unknown as typeof fetch });
		const pi = await ac.paymentIntents.create({ amount: 93000, order_id: 'ORD-1' }, { idempotencyKey: 'order-ORD-1' });
		expect(pi.unique_amount).toBe(93007);
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.example.com/v1/payment_intents');
		const h = init.headers as Record<string, string>;
		expect(h.authorization).toBe(`Bearer ${SK}`);
		expect(h['idempotency-key']).toBe('order-ORD-1');
		expect(JSON.parse(String(init.body))).toEqual({ amount: 93000, order_id: 'ORD-1' });
	});

	it('refuses floats and publishable keys', () => {
		expect(() => new AutoConfirm('pk_test_x')).toThrow();
		const ac = new AutoConfirm(SK, { fetch: fakeFetch() as unknown as typeof fetch });
		expect(() => ac.paymentIntents.create({ amount: 930.07 })).toThrow(/integer paise/);
	});

	it('turns API errors into AutoConfirmError', async () => {
		const ac = new AutoConfirm(SK, { fetch: fakeFetch(json(409, { error: { type: 'conflict', code: 'slots_exhausted', message: 'full' } })) as unknown as typeof fetch });
		const e = await ac.paymentIntents.create({ amount: 1000 }).catch((x: unknown) => x);
		expect(e).toBeInstanceOf(AutoConfirmError);
		expect(e).toMatchObject({ status: 409, code: 'slots_exhausted' });
	});

	it('retries GETs and idempotent POSTs on 5xx/network errors, never plain POSTs', async () => {
		const f = fakeFetch(new Error('reset'), json(503, {}), json(200, { id: 'pi_1' }));
		const ac = new AutoConfirm(SK, { fetch: f as unknown as typeof fetch });
		expect((await ac.paymentIntents.retrieve('pi_1')).id).toBe('pi_1');
		expect(f).toHaveBeenCalledTimes(3);
		const g = fakeFetch(json(503, { error: { code: 'x' } }));
		const ac2 = new AutoConfirm(SK, { fetch: g as unknown as typeof fetch });
		await expect(ac2.paymentIntents.cancel('pi_1')).rejects.toBeInstanceOf(AutoConfirmError);
		expect(g).toHaveBeenCalledTimes(1);
	});

	it('builds list queries', async () => {
		const f = fakeFetch(json(200, { object: 'list', data: [], has_more: false }));
		const ac = new AutoConfirm(SK, { fetch: f as unknown as typeof fetch });
		await ac.signals.list({ status: 'unmatched', limit: 10 });
		expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://api.example.com/v1/signals?status=unmatched&limit=10');
	});
});

describe('webhooks.constructEvent', () => {
	const secret = 'whsec_test';
	const body = JSON.stringify({ id: 'evt_1', object: 'event', type: 'payment_intent.paid', data: { object: { id: 'pi_1' } } });
	const ac = new AutoConfirm(SK, { fetch: fakeFetch() as unknown as typeof fetch });

	it('accepts a signature made by the server code', async () => {
		const header = await signWebhook(secret, body, Math.floor(Date.now() / 1000));
		const ev = await ac.webhooks.constructEvent<{ id: string }>(body, header, secret);
		expect(ev.type).toBe('payment_intent.paid');
		expect(ev.data.object.id).toBe('pi_1');
	});

	it('rejects tampering, wrong secrets, old timestamps and missing headers', async () => {
		const now = Math.floor(Date.now() / 1000);
		const header = await signWebhook(secret, body, now);
		await expect(ac.webhooks.constructEvent(body + ' ', header, secret)).rejects.toBeInstanceOf(SignatureVerificationError);
		await expect(ac.webhooks.constructEvent(body, header, 'other')).rejects.toBeInstanceOf(SignatureVerificationError);
		await expect(ac.webhooks.constructEvent(body, await signWebhook(secret, body, now - 301), secret)).rejects.toThrow(/tolerance/);
		await expect(ac.webhooks.constructEvent(body, undefined, secret)).rejects.toThrow(/missing/);
	});
});
