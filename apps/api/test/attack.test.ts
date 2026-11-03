// Attack and race tests: many requests at the same instant, replays, extreme clocks, junk input, other tenants.
// The rule for every test: money is never applied twice, nothing crashes (no 500s), nothing leaks.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { sha256Hex, signDeviceRequest } from '@autoconfirm/core';
import { call, createIntent, deviceCall, pairDevice, sendSignal, setup } from './helpers.ts';

const MIN = 60_000;
let k = 0;
const keyHash = async () => (await sha256Hex(`attack-${++k}-${Math.random()}`)).slice(0, 32);

async function paidEvents(merchantId: string, intentId: string) {
	const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE merchant_id = ? AND object_id = ? AND type = 'payment_intent.paid'").bind(merchantId, intentId).first<{ n: number }>();
	return r!.n;
}

describe('races: many requests at the same instant', () => {
	it('100 payments for the same amount at once: 99 unique amounts, then a clean "slots exhausted"', async () => {
		const { keys } = await setup();
		const all = await Promise.all(Array.from({ length: 100 }, () => createIntent(keys.sk, { amount: 50000 })));
		const ok = all.filter((r) => r.status === 201);
		expect(ok).toHaveLength(99);
		expect(new Set(ok.map((r) => r.json.unique_amount)).size).toBe(99);
		const refused = all.filter((r) => r.status !== 201);
		expect(refused.map((r) => [r.status, r.json.error.code])).toEqual([[409, 'slots_exhausted']]);
	});

	it('the same Idempotency-Key sent 10 times at once makes one payment', async () => {
		const { keys } = await setup();
		const all = await Promise.all(Array.from({ length: 10 }, () => createIntent(keys.sk, { amount: 50000 }, { 'idempotency-key': 'double-tap' })));
		const ids = new Set(all.filter((r) => r.status === 201).map((r) => r.json.id));
		expect(ids.size).toBe(1);
		for (const r of all) expect([201, 409]).toContain(r.status); // 409 = "still being processed", never a second payment
		const list = await call('GET', '/v1/payment_intents', { key: keys.sk });
		expect(list.json.data).toHaveLength(1);
	});

	it('one payment alert uploaded 20 times at once pays the order exactly once', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const same = { notification_key_hash: await keyHash(), posted_at: Date.now() };
		const all = await Promise.all(Array.from({ length: 20 }, () => sendSignal(device, pi.unique_amount, same)));
		for (const r of all) expect(r.status).toBe(200);
		const statuses = all.map((r) => r.json.results[0]);
		expect(statuses.filter((s: { repeat: boolean }) => !s.repeat)).toHaveLength(1);
		expect(new Set(statuses.map((s: { signal_id: string }) => s.signal_id)).size).toBe(1);
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk })).json.status).toBe('paid');
		expect(await paidEvents(keys.merchantId, pi.id)).toBe(1);
	});

	it('two phones and two channels (app + bank SMS) reporting one payment at once: paid once, the rest are copies', async () => {
		const { keys, device, locationId } = await setup();
		const backup = await pairDevice(keys.sk, locationId);
		const pi = (await createIntent(keys.sk)).json;
		const t = Date.now();
		const all = await Promise.all([
			sendSignal(device, pi.unique_amount, { app: 'google_pay', payer_short: 'Ramesh Patel', posted_at: t }),
			sendSignal(device, pi.unique_amount, { app: 'bank_sms', payer_short: null, posted_at: t + 3000 }),
			sendSignal(backup, pi.unique_amount, { app: 'google_pay', payer_short: 'Ramesh Patel', posted_at: t + 1000 }),
			sendSignal(backup, pi.unique_amount, { app: 'bank_sms', payer_short: null, posted_at: t + 4000 }),
		]);
		const st = all.map((r) => r.json.results[0].status).sort();
		expect(st).toEqual(['duplicate', 'duplicate', 'duplicate', 'matched']);
		expect(await paidEvents(keys.merchantId, pi.id)).toBe(1);
	});

	it('staff "mark paid" and the phone alert at the same moment: paid once', async () => {
		for (let round = 0; round < 5; round++) {
			const { keys, device } = await setup();
			const pi = (await createIntent(keys.sk)).json;
			const [manual, sig] = await Promise.all([
				call('POST', `/v1/payment_intents/${pi.id}/mark_paid`, { key: keys.sk, body: { note: 'soundbox' } }),
				sendSignal(device, pi.unique_amount),
			]);
			expect([200, 409]).toContain(manual.status);
			const status = sig.json.results[0].status;
			// Whoever came second lost cleanly: either the manual mark was refused, or the alert went to the inbox.
			expect(manual.status === 200 ? status === 'unmatched' : status === 'matched').toBe(true);
			expect(await paidEvents(keys.merchantId, pi.id)).toBe(1);
		}
	});

	it('cancel and the phone alert at the same moment: never both paid and cancelled', async () => {
		for (let round = 0; round < 5; round++) {
			const { keys, device } = await setup();
			const pi = (await createIntent(keys.sk)).json;
			const [cancel, sig] = await Promise.all([call('POST', `/v1/payment_intents/${pi.id}/cancel`, { key: keys.sk }), sendSignal(device, pi.unique_amount)]);
			const final = (await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk })).json.status;
			if (cancel.status === 200) {
				expect(final).toBe('cancelled');
				expect(sig.json.results[0].status).toBe('unmatched'); // money for a cancelled order goes to the inbox
				expect(await paidEvents(keys.merchantId, pi.id)).toBe(0);
			} else {
				expect(final).toBe('paid');
				expect(await paidEvents(keys.merchantId, pi.id)).toBe(1);
			}
		}
	});

	it('two inbox payments matched to one order at once: only one wins', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const a = (await sendSignal(device, 93000)).json.results[0].signal_id; // customer paid the round amount
		const b = (await sendSignal(device, 93001, { payer_short: 'Sita K' })).json.results[0].signal_id;
		const both = await Promise.all([a, b].map((s) => call('POST', `/v1/signals/${s}/assign`, { key: keys.sk, body: { payment_intent: pi.id } })));
		expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(await paidEvents(keys.merchantId, pi.id)).toBe(1);
	});
});

describe('replays and forged phone requests', () => {
	it('a captured request replayed, or with the body changed, is refused', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const body = { signals: [{ app: 'google_pay', amount_paise: pi.unique_amount, posted_at: Date.now(), notification_key_hash: await keyHash() }] };
		const nonce = 'n_replay_test_0001';
		const first = await deviceCall(device, 'POST', '/device/v1/signals', body, { nonce });
		expect(first.status).toBe(200);
		const replay = await deviceCall(device, 'POST', '/device/v1/signals', body, { nonce });
		expect(replay.status).toBe(401);
		// The real signature of the captured request, sent with a changed amount: refused.
		const ts = Math.floor(Date.now() / 1000);
		const captured = await signDeviceRequest(device.secret, { method: 'POST', path: '/device/v1/signals', timestamp: String(ts), nonce: 'n_tamper_test_0002', body: JSON.stringify(body) });
		const tampered = { signals: [{ ...body.signals[0]!, amount_paise: 1 }] };
		const forged = await deviceCall(device, 'POST', '/device/v1/signals', tampered, { timestamp: ts, nonce: 'n_tamper_test_0002', signature: captured });
		expect(forged.status).toBe(401);
		expect((await deviceCall(device, 'POST', '/device/v1/signals', tampered, { nonce: 'n_tamper_test_0003', signature: 'a'.repeat(64) })).status).toBe(401);
		// Too short / odd request ids are refused outright.
		expect((await deviceCall(device, 'POST', '/device/v1/signals', body, { nonce: 'short' })).status).toBe(401);
		// A request signed with another phone's secret is refused.
		const other = await setup();
		expect((await deviceCall(device, 'POST', '/device/v1/signals', body, { secret: other.device.secret })).status).toBe(401);
	});

	it('a removed phone can do nothing, even with a valid signature', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		await call('POST', `/v1/devices/${device.id}/revoke`, { key: keys.sk });
		expect((await sendSignal(device, pi.unique_amount)).status).toBe(401);
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk })).json.status).toBe('pending');
	});
});

describe('extreme phone clocks', () => {
	it('a payment sent before the order existed never pays it, whatever the phone clock says', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const early = await sendSignal(device, pi.unique_amount, { posted_at: Date.now() - 10 * MIN });
		expect(early.json.results[0].status).toBe('unmatched');
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk })).json.status).toBe('pending');
	});

	it('a phone clock far in the future is capped at "now"; alerts older than a day are ignored', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const future = await sendSignal(device, pi.unique_amount, { posted_at: Date.now() + 365 * 24 * 60 * MIN });
		expect(future.json.results[0].status).toBe('matched');
		const old = await sendSignal(device, 93000, { posted_at: Date.now() - 25 * 60 * MIN });
		expect(old.json.results[0].status).toBe('ignored');
		const zero = await sendSignal(device, 93000, { posted_at: 0 });
		expect(zero.json.results[0].status).toBe('ignored');
	});
});

describe('junk input never crashes the server', () => {
	it('bad payment requests get a clear 4xx, never a 500', async () => {
		const { keys } = await setup();
		const bad: unknown[] = [
			{ amount: 930.5 },
			{ amount: -100 },
			{ amount: 0 },
			{ amount: '93000' },
			{ amount: 1e30 },
			{ amount: 99 },
			{ amount: 10_000_001 },
			{ amount: null },
			{},
			{ amount: 93000, extra: 'field' },
			{ amount: 93000, order_id: 'x'.repeat(65) },
			{ amount: 93000, metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])) },
			{ amount: 93000, return_url: 'javascript:alert(1)' },
			{ amount: 93000, expires_in: 10 },
			{ amount: 93000, location_id: 'loc_doesnotexist' },
			{ amount: 93000, project_id: 'prj_doesnotexist' },
			[1, 2, 3],
			'just a string',
			{ amount: { $gt: 0 } },
		];
		for (const body of bad) {
			const r = await call('POST', '/v1/payment_intents', { key: keys.sk, body });
			expect(r.status, JSON.stringify(body).slice(0, 80)).toBeGreaterThanOrEqual(400);
			expect(r.status, JSON.stringify(body).slice(0, 80)).toBeLessThan(500);
		}
		for (const raw of ['{', '', 'null', '{"amount": 93000,}', '\u0000', '{"amount":93000}'.padEnd(20_000, ' ')]) {
			const r = await call('POST', '/v1/payment_intents', { key: keys.sk, body: raw });
			expect(r.status, `raw ${raw.slice(0, 20)}`).toBeGreaterThanOrEqual(400);
			expect(r.status).toBeLessThan(500);
		}
		expect((await call('POST', '/v1/payment_intents', { key: keys.sk, body: {}, headers: { 'idempotency-key': 'x'.repeat(65) } })).status).toBe(400);
	});

	it('bad phone uploads get a 4xx and change nothing', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const bad: unknown[] = [
			{ signals: [] },
			{ signals: Array.from({ length: 51 }, () => ({ app: 'google_pay', amount_paise: 100, posted_at: 1, notification_key_hash: 'ab'.repeat(16) })) },
			{ signals: [{ app: 'google_pay', amount_paise: pi.unique_amount + 0.5, posted_at: Date.now(), notification_key_hash: 'ab'.repeat(16) }] },
			{ signals: [{ app: 'google_pay', amount_paise: -1, posted_at: Date.now(), notification_key_hash: 'ab'.repeat(16) }] },
			{ signals: [{ app: 'Google Pay!', amount_paise: pi.unique_amount, posted_at: Date.now(), notification_key_hash: 'ab'.repeat(16) }] },
			{ signals: [{ app: 'google_pay', amount_paise: pi.unique_amount, posted_at: Date.now(), notification_key_hash: 'not hex' }] },
			{ signals: [{ app: 'google_pay', amount_paise: pi.unique_amount, posted_at: Date.now(), notification_key_hash: 'ab'.repeat(16), raw_text: 'leak' }] },
			{ nope: true },
		];
		for (const body of bad) {
			const r = await deviceCall(device, 'POST', '/device/v1/signals', body);
			expect(r.status, JSON.stringify(body).slice(0, 80)).toBeGreaterThanOrEqual(400);
			expect(r.status).toBeLessThan(500);
		}
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk })).json.status).toBe('pending');
		const sigs = await env.DB.prepare('SELECT COUNT(*) AS n FROM signals WHERE merchant_id = ?').bind(keys.merchantId).first<{ n: number }>();
		expect(sigs!.n).toBe(0);
	});

	it('bad or missing keys are 401, never a crash', async () => {
		for (const key of ['', 'sk_live_', 'sk_test_short', `sk_test_${'x'.repeat(200)}`, 'pk_test_' + 'a'.repeat(40), 'ses_' + 'a'.repeat(43), "' OR 1=1 --"]) {
			const r = await call('GET', '/v1/payment_intents', { key });
			expect(r.status, key.slice(0, 20)).toBe(401);
		}
	});
});

describe("another shop can't reach this shop's money", () => {
	it("every route with a foreign id is 404/403, and the owner's data is unchanged", async () => {
		const a = await setup();
		const b = await setup();
		const pi = (await createIntent(a.keys.sk)).json;
		const sig = (await sendSignal(a.device, 93000)).json.results[0].signal_id;
		const probes: [string, string, unknown?][] = [
			['GET', `/v1/payment_intents/${pi.id}`],
			['POST', `/v1/payment_intents/${pi.id}/cancel`, {}],
			['POST', `/v1/payment_intents/${pi.id}/mark_paid`, {}],
			['POST', `/v1/payment_intents/${pi.id}/unmark_paid`, { reason: 'x' }],
			['GET', `/v1/signals/${sig}`],
			['POST', `/v1/signals/${sig}/assign`, { payment_intent: pi.id }],
			['POST', `/v1/signals/${sig}/ignore`, {}],
			['POST', `/v1/signals/${sig}/reject`, {}],
			['POST', `/v1/locations/${a.locationId}/pairing_codes`, {}],
			['POST', `/v1/locations/${a.locationId}`, { active: false }],
			['GET', `/v1/devices?location_id=${a.locationId}`],
			['POST', `/v1/devices/${a.device.id}/revoke`, {}],
			['POST', '/v1/payment_intents', { amount: 93000, location_id: a.locationId }],
		];
		for (const [m, path, body] of probes) {
			const r = await call(m, path, { key: b.keys.sk, body });
			if (path.startsWith('/v1/devices?')) {
				expect(r.json.data, path).toHaveLength(0);
				continue;
			}
			expect([403, 404], `${m} ${path} → ${r.status}`).toContain(r.status);
		}
		// Public checkout with B's publishable key can't show A's payment.
		expect((await call('GET', `/v1/public/payment_intents/${pi.id}`, { key: b.keys.pk })).status).toBe(404);
		// A's things are untouched.
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: a.keys.sk })).json.status).toBe('pending');
		expect((await call('GET', `/v1/signals/${sig}`, { key: a.keys.sk })).json.status).toBe('unmatched');
		expect((await sendSignal(a.device, pi.unique_amount)).status).toBe(200); // phone still works
	});
});
