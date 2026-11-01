import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult, runDurableObjectAlarm } from 'cloudflare:test';
import { verifyWebhook } from '@autoconfirm/core';
import worker from '../src/index.ts';
import { app, shortPayer } from '../src/app.ts';
import { locationObjectName } from '../src/location-do.ts';
import { call, createIntent, deviceCall, newLocation, newMerchant, pairDevice, sendSignal, setup } from './helpers.ts';

describe('payment intents', () => {
	it('creates an intent with a unique paise amount and UPI links', async () => {
		const { keys, locationId } = await setup();
		const r = await createIntent(keys.sk, { metadata: { cart_id: 'c_1' }, customer: { name: 'Ramesh Patel' } });
		expect(r.status).toBe(201);
		expect(r.json).toMatchObject({ object: 'payment_intent', status: 'pending', amount: 93000, currency: 'INR', order_id: 'ORD-1042', location_id: locationId, livemode: false, metadata: { cart_id: 'c_1' } });
		expect(r.json.id).toMatch(/^pi_[a-z2-7]{20}$/);
		expect(r.json.unique_amount).toBeGreaterThan(93000);
		expect(r.json.unique_amount).toBeLessThanOrEqual(93099);
		expect(r.json.display_amount).toBe((r.json.unique_amount / 100).toFixed(2));
		expect(r.json.upi.uri).toContain(`am=${r.json.display_amount}`);
		expect(r.json.upi.uri).toContain('pa=shop@ybl');
		expect(r.json.upi.uri).toContain(`tr=${r.json.id}`);
		expect(r.json.checkout_url).toBe(`https://pay.example.com/p/${r.json.id}`);
	});

	it('never gives two open intents the same amount, even when created in parallel', async () => {
		const { keys } = await setup();
		const results = await Promise.all(Array.from({ length: 30 }, () => createIntent(keys.sk, { amount: 50000 })));
		expect(results.every((r) => r.status === 201)).toBe(true);
		const amounts = results.map((r) => r.json.unique_amount);
		expect(new Set(amounts).size).toBe(30);
	});

	it('is idempotent with Idempotency-Key, and rejects reuse with a different body', async () => {
		const { keys } = await setup();
		const a = await createIntent(keys.sk, {}, { 'idempotency-key': 'order-1042' });
		const b = await createIntent(keys.sk, {}, { 'idempotency-key': 'order-1042' });
		expect(b.status).toBe(201);
		expect(b.json.id).toBe(a.json.id);
		expect(b.json.unique_amount).toBe(a.json.unique_amount);
		const c = await createIntent(keys.sk, { amount: 1000 }, { 'idempotency-key': 'order-1042' });
		expect(c.status).toBe(409);
		expect(c.json.error.code).toBe('idempotency_mismatch');
	});

	it('validates input', async () => {
		const { keys } = await setup();
		expect((await createIntent(keys.sk, { amount: 50 })).json.error.param).toBe('amount');
		expect((await createIntent(keys.sk, { amount: 930.07 })).status).toBe(400);
		expect((await createIntent(keys.sk, { surprise: true })).status).toBe(400);
		expect((await call('POST', '/v1/payment_intents', { key: keys.sk, body: '{bad json' })).json.error.code).toBe('invalid_json');
		expect((await call('POST', '/v1/payment_intents', { key: keys.sk, body: 'x'.repeat(17 * 1024) })).status).toBe(413);
	});

	it('needs a paired phone, and a location_id when there are several locations', async () => {
		const keys = await newMerchant();
		const loc1 = await newLocation(keys.sk);
		expect((await createIntent(keys.sk)).json.error.code).toBe('location_not_ready');
		await pairDevice(keys.sk, loc1);
		expect((await createIntent(keys.sk)).status).toBe(201);
		await newLocation(keys.sk, 'Counter 2');
		expect((await createIntent(keys.sk)).json.error.code).toBe('location_required');
		expect((await createIntent(keys.sk, { location_id: loc1 })).status).toBe(201);
	});

	it('cancel, then mark paid is refused', async () => {
		const { keys } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const c = await call('POST', `/v1/payment_intents/${pi.id}/cancel`, { key: keys.sk });
		expect(c.json.status).toBe('cancelled');
		const m = await call('POST', `/v1/payment_intents/${pi.id}/mark_paid`, { key: keys.sk, body: {} });
		expect(m.status).toBe(409);
	});

	it('manual mark paid and undo', async () => {
		const { keys } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const m = await call('POST', `/v1/payment_intents/${pi.id}/mark_paid`, { key: keys.sk, body: { note: 'checked soundbox' } });
		expect(m.json).toMatchObject({ status: 'paid', match: { source: 'manual' } });
		const u = await call('POST', `/v1/payment_intents/${pi.id}/unmark_paid`, { key: keys.sk, body: { reason: 'wrong order' } });
		expect(u.json.status).toBe('pending');
		const audit = await env.DB.prepare('SELECT action FROM audit_log WHERE merchant_id = ? ORDER BY id').bind(keys.merchantId).all<{ action: string }>();
		expect(audit.results.map((a) => a.action)).toEqual(['intent.mark_paid', 'intent.unmark_paid']);
	});

	it('lists intents newest first with pagination', async () => {
		const { keys } = await setup();
		for (let k = 0; k < 3; k++) await createIntent(keys.sk, { amount: 10000 + k * 100 });
		const p1 = await call('GET', '/v1/payment_intents?limit=2', { key: keys.sk });
		expect(p1.json.data).toHaveLength(2);
		expect(p1.json.has_more).toBe(true);
		const p2 = await call('GET', `/v1/payment_intents?limit=2&starting_after=${p1.json.data[1].id}`, { key: keys.sk });
		expect(p2.json.data).toHaveLength(1);
		expect(p2.json.has_more).toBe(false);
	});
});

describe('matching through the API', () => {
	it('a wrong amount goes to the inbox and can be assigned', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const s = await sendSignal(device, 93000); // customer paid the round amount
		expect(s.json.results[0].status).toBe('unmatched');
		const inbox = await call('GET', '/v1/signals?status=unmatched', { key: keys.sk });
		expect(inbox.json.data).toHaveLength(1);
		expect(inbox.json.data[0]).toMatchObject({ amount: 93000, payer_name: 'Ramesh P' }); // payer name is shortened
		const a = await call('POST', `/v1/signals/${inbox.json.data[0].id}/assign`, { key: keys.sk, body: { payment_intent: pi.id } });
		expect(a.json).toMatchObject({ status: 'paid', match: { source: 'manual', amount_mismatch: true, received_amount: 93000 } });
	});

	it('a payment far from every order is a likely walk-in, kept apart from the inbox', async () => {
		const { keys, device } = await setup();
		await createIntent(keys.sk); // ₹930.xx
		await sendSignal(device, 93000); // round amount: needs a look
		await sendSignal(device, 6000); // ₹60 tea: walk-in
		const check = await call('GET', '/v1/signals?status=unmatched&walk_in=false', { key: keys.sk });
		expect(check.json.data.map((x: { amount: number }) => x.amount)).toEqual([93000]);
		const other = await call('GET', '/v1/signals?status=unmatched&walk_in=true', { key: keys.sk });
		expect(other.json.data).toHaveLength(1);
		expect(other.json.data[0]).toMatchObject({ amount: 6000, likely_walk_in: true });
		const ev = await env.DB.prepare("SELECT payload FROM events WHERE merchant_id = ? AND type = 'signal.unmatched'").bind(keys.merchantId).all<{ payload: string }>();
		const unmatched = ev.results.map((e) => JSON.parse(e.payload).data.object);
		expect(unmatched).toEqual(expect.arrayContaining([expect.objectContaining({ amount: 6000, likely_walk_in: true }), expect.objectContaining({ amount: 93000, likely_walk_in: false })]));
		// The filter can be turned off per merchant.
		const off = await setup({ walk_in_filter: false });
		await sendSignal(off.device, 6000);
		const all = await call('GET', '/v1/signals?status=unmatched&walk_in=false', { key: off.keys.sk });
		expect(all.json.data).toHaveLength(1);
	});

	it('a duplicate upload is a repeat and does not create a second signal', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const item = { app: 'gpay_business', amount_paise: pi.unique_amount, posted_at: Date.now(), notification_key_hash: 'ab'.repeat(16) };
		const a = await deviceCall(device, 'POST', '/device/v1/signals', { signals: [item] });
		const b = await deviceCall(device, 'POST', '/device/v1/signals', { signals: [item] });
		expect(a.json.results[0].status).toBe('matched');
		expect(b.json.results[0]).toMatchObject({ repeat: true, signal_id: a.json.results[0].signal_id });
		const all = await call('GET', '/v1/signals', { key: keys.sk });
		expect(all.json.data).toHaveLength(1);
	});

	it('the backup phone copy is a duplicate and does not pay the next order', async () => {
		const { keys, device, locationId } = await setup();
		const backup = await pairDevice(keys.sk, locationId);
		const pi = (await createIntent(keys.sk)).json;
		await sendSignal(device, pi.unique_amount, { payer_short: 'Ramesh P' });
		const next = (await createIntent(keys.sk)).json;
		expect(next.unique_amount).not.toBe(pi.unique_amount); // cool-down
		const copy = await sendSignal(backup, pi.unique_amount, { payer_short: 'Ramesh P' });
		expect(copy.json.results[0].status).toBe('duplicate');
		expect((await call('GET', `/v1/payment_intents/${next.id}`, { key: keys.sk })).json.status).toBe('pending');
	});

	it('above auto_confirm_max a match waits for staff (review), then confirm pays it', async () => {
		const { keys, device } = await setup({ auto_confirm_max: 200000 });
		const pi = (await createIntent(keys.sk, { amount: 450000 })).json;
		const s = await sendSignal(device, pi.unique_amount);
		expect(s.json.results[0].status).toBe('review');
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk })).json.status).toBe('pending');
		const review = await call('GET', '/v1/signals?status=review', { key: keys.sk });
		expect(review.json.data[0]).toMatchObject({ payment_intent: pi.id });
		const ok = await call('POST', `/v1/signals/${review.json.data[0].id}/assign`, { key: keys.sk, body: { payment_intent: pi.id } });
		expect(ok.json).toMatchObject({ status: 'paid', match: { source: 'manual' } });
	});

	it('reject a review signal', async () => {
		const { keys, device } = await setup({ auto_confirm_max: 200000 });
		const pi = (await createIntent(keys.sk, { amount: 450000 })).json;
		const s = await sendSignal(device, pi.unique_amount);
		const r = await call('POST', `/v1/signals/${s.json.results[0].signal_id}/reject`, { key: keys.sk, body: { reason: 'not on soundbox' } });
		expect(r.json).toMatchObject({ status: 'unmatched', payment_intent: null });
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk })).json.status).toBe('pending');
	});

	it('test-mode phones never pay live intents', async () => {
		const keys = await newMerchant();
		const loc = await newLocation(keys.sk);
		const testPhone = await pairDevice(keys.sk, loc);
		await pairDevice(keys.skLive, loc);
		const live = (await createIntent(keys.skLive)).json;
		expect(live.livemode).toBe(true);
		const s = await sendSignal(testPhone, live.unique_amount);
		expect(s.json.results[0].status).toBe('unmatched');
		expect((await call('GET', `/v1/payment_intents/${live.id}`, { key: keys.skLive })).json.status).toBe('pending');
		// And test keys can't see live objects.
		expect((await call('GET', `/v1/payment_intents/${live.id}`, { key: keys.sk })).status).toBe(404);
	});

	it('writes events to D1 and keeps no outbox backlog', async () => {
		const { keys, device, locationId } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		await sendSignal(device, pi.unique_amount);
		const ev = await env.DB.prepare('SELECT type, payload FROM events WHERE merchant_id = ? AND object_id = ?').bind(keys.merchantId, pi.id).first<{ type: string; payload: string }>();
		expect(ev?.type).toBe('payment_intent.paid');
		expect(JSON.parse(ev!.payload).data.object).toMatchObject({ id: pi.id, status: 'paid', match: { source: 'auto', app: 'phonepe_business' } });
		const stub = env.LOCATION.get(env.LOCATION.idFromName(locationObjectName(keys.merchantId, locationId, false)));
		expect((await stub.inspect()).outbox).toBe(0);
		expect(await runDurableObjectAlarm(stub)).toBe(true); // expiry alarm is scheduled and runs cleanly
	});
});

describe('public endpoints', () => {
	it('status and claim with the publishable key, no personal data', async () => {
		const { keys } = await setup();
		const pi = (await createIntent(keys.sk, { customer: { name: 'Ramesh Patel', phone: '9800000000' } })).json;
		const st = await call('GET', `/v1/public/payment_intents/${pi.id}/status`, { key: keys.pk });
		expect(st.json).toEqual({ status: 'pending', display_amount: pi.display_amount, expires_at: pi.expires_at, paid_at: null });
		const cl = await call('POST', `/v1/public/payment_intents/${pi.id}/claim`, { key: keys.pk });
		expect(cl.json.status).toBe('pending');
		const full = await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk });
		expect(full.json.customer_claimed_at).not.toBeNull();
	});

	it('key kinds are not interchangeable', async () => {
		const { keys } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.pk })).status).toBe(401);
		expect((await call('GET', `/v1/public/payment_intents/${pi.id}/status`, { key: keys.sk })).status).toBe(401);
		expect((await call('GET', `/v1/payment_intents/${pi.id}`)).status).toBe(401);
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: 'sk_test_' + 'x'.repeat(43) })).status).toBe(401);
	});
});

describe('device security', () => {
	it('rejects a bad signature, a replayed nonce, clock skew and a revoked phone', async () => {
		const { device } = await setup();
		const body = { device_time: Date.now(), listener_connected: true };
		expect((await deviceCall(device, 'POST', '/device/v1/heartbeat', body, { secret: 'wrong' })).status).toBe(401);
		expect((await deviceCall(device, 'POST', '/device/v1/heartbeat', body, { timestamp: Math.floor(Date.now() / 1000) - 400 })).status).toBe(401);
		const nonce = 'n_replay_0123456789abcdef';
		expect((await deviceCall(device, 'POST', '/device/v1/heartbeat', body, { nonce })).status).toBe(200);
		const replay = await deviceCall(device, 'POST', '/device/v1/heartbeat', body, { nonce });
		expect(replay.status).toBe(401);
		expect(replay.json.error.code).toBe('replayed_nonce');
		await env.DB.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?").bind(device.id).run();
		expect((await deviceCall(device, 'POST', '/device/v1/heartbeat', body)).status).toBe(401);
	});

	it('refuses to make a pairing link with an internal address (PUBLIC_API_URL missing)', async () => {
		const keys = await newMerchant();
		const loc = await newLocation(keys.sk);
		const res = await app.request(`https://api.internal/v1/locations/${loc}/pairing_codes`, { method: 'POST', headers: { authorization: `Bearer ${keys.sk}` } }, env);
		expect(res.status).toBe(500);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('public_api_url_missing');
	});

	it('the phone can unpair itself; only itself', async () => {
		const { keys, device, locationId } = await setup();
		const other = await pairDevice(keys.sk, locationId);
		expect((await deviceCall(device, 'POST', '/device/v1/unpair', {})).status).toBe(200);
		expect((await deviceCall(device, 'POST', '/device/v1/heartbeat', { device_time: Date.now(), listener_connected: true })).status).toBe(401);
		expect((await deviceCall(other, 'POST', '/device/v1/heartbeat', { device_time: Date.now(), listener_connected: true })).status).toBe(200);
		const row = await env.DB.prepare('SELECT status FROM devices WHERE id = ?').bind(device.id).first<{ status: string }>();
		expect(row!.status).toBe('revoked');
	});

	it('one UPI ID can only be one counter per merchant', async () => {
		const keys = await newMerchant();
		await newLocation(keys.sk);
		const dup = await call('POST', '/v1/locations', { key: keys.sk, body: { name: 'Counter 2', upi_vpa: 'SHOP@ybl', upi_payee_name: 'My Shop' } });
		expect(dup.status).toBe(409);
		expect(dup.json.error.code).toBe('upi_id_in_use');
		expect((await call('POST', '/v1/locations', { key: keys.sk, body: { name: 'Counter 2', upi_vpa: 'shop2@ybl', upi_payee_name: 'My Shop' } })).status).toBe(201);
		// Another merchant is not affected.
		const other = await newMerchant();
		expect((await call('POST', '/v1/locations', { key: other.sk, body: { name: 'C', upi_vpa: 'shop@ybl', upi_payee_name: 'X' } })).status).toBe(201);
	});

	it('a pairing code works once', async () => {
		const keys = await newMerchant();
		const loc = await newLocation(keys.sk);
		const pc = await call('POST', `/v1/locations/${loc}/pairing_codes`, { key: keys.sk });
		expect(pc.json.pairing_link).toBe(`autoconfirm://pair?api=${encodeURIComponent('http://localhost')}&code=${pc.json.code}`);
		expect((await call('POST', '/device/v1/enroll', { body: { pairing_code: pc.json.code } })).status).toBe(201);
		expect((await call('POST', '/device/v1/enroll', { body: { pairing_code: pc.json.code } })).status).toBe(401);
		expect((await call('POST', '/device/v1/enroll', { body: { pairing_code: 'pc_doesnotexist000' } })).status).toBe(401);
	});

	it('heartbeat stores the phone clock offset, which corrects paid_time', async () => {
		const { keys, device } = await setup();
		const slow = 10 * 60_000; // phone clock 10 min slow
		expect((await deviceCall(device, 'POST', '/device/v1/heartbeat', { device_time: Date.now() - slow, listener_connected: true })).status).toBe(200);
		const row = await env.DB.prepare('SELECT status, clock_offset_ms FROM devices WHERE id = ?').bind(device.id).first<{ status: string; clock_offset_ms: number }>();
		expect(row!.status).toBe('online');
		expect(Math.abs(row!.clock_offset_ms - slow)).toBeLessThan(5_000);
		// The phone's posted_at looks 10 min old, but corrected it is "now", after the intent was created.
		const pi = (await createIntent(keys.sk)).json;
		const s = await sendSignal(device, pi.unique_amount, { posted_at: Date.now() - slow });
		expect(s.json.results[0].status).toBe('matched');
	});

	it('serves parser rules with version caching', async () => {
		const { device } = await setup();
		expect((await deviceCall(device, 'GET', '/device/v1/parser_rules', undefined)).status).toBe(404);
		await env.RULES.put('active', JSON.stringify({ version: '2026-11-01.1', apps: [] }));
		const r = await deviceCall(device, 'GET', '/device/v1/parser_rules', undefined);
		expect(r.json.version).toBe('2026-11-01.1');
		expect((await deviceCall(device, 'GET', '/device/v1/parser_rules?version=2026-11-01.1', undefined)).status).toBe(304);
	});
});

describe('tenancy: merchant B can never touch merchant A', () => {
	it('every endpoint refuses cross-tenant ids', async () => {
		const a = await setup({ auto_confirm_max: 200000 });
		const b = await setup();
		const pi = (await createIntent(a.keys.sk)).json;
		const big = (await createIntent(a.keys.sk, { amount: 450000 })).json;
		const sig = (await sendSignal(a.device, 93000)).json.results[0].signal_id;
		const reviewSig = (await sendSignal(a.device, big.unique_amount)).json.results[0].signal_id;
		const B = b.keys.sk;

		const expect404 = async (method: string, path: string, body?: unknown) => {
			const r = await call(method, path, { key: B, body });
			expect(r.status, `${method} ${path}`).toBe(404);
		};
		await expect404('GET', `/v1/payment_intents/${pi.id}`);
		await expect404('POST', `/v1/payment_intents/${pi.id}/cancel`);
		await expect404('POST', `/v1/payment_intents/${pi.id}/mark_paid`, {});
		await expect404('POST', `/v1/payment_intents/${pi.id}/unmark_paid`, { reason: 'x' });
		await expect404('GET', `/v1/signals/${sig}`);
		await expect404('POST', `/v1/signals/${sig}/ignore`, {});
		await expect404('POST', `/v1/signals/${reviewSig}/reject`, {});
		await expect404('POST', `/v1/locations/${a.locationId}/pairing_codes`);
		await expect404('POST', '/v1/payment_intents', { amount: 1000, location_id: a.locationId });
		// B's own intent + A's signal, and A's intent + B's signal
		const bPi = (await createIntent(B)).json;
		await expect404('POST', `/v1/signals/${sig}/assign`, { payment_intent: bPi.id });
		const bSig = (await sendSignal(b.device, 1234)).json.results[0].signal_id;
		await expect404('POST', `/v1/signals/${bSig}/assign`, { payment_intent: pi.id });
		await expect404('POST', `/v1/payment_intents/${bPi.id}/mark_paid`, { signal_id: sig });

		// Lists only show B's own objects.
		const intents = await call('GET', '/v1/payment_intents', { key: B });
		expect(intents.json.data.map((i: { id: string }) => i.id)).toEqual([bPi.id]);
		const signals = await call('GET', '/v1/signals', { key: B });
		expect(signals.json.data.map((s: { id: string }) => s.id)).toEqual([bSig]);
		const locs = await call('GET', '/v1/locations', { key: B });
		expect(locs.json.data.map((l: { id: string }) => l.id)).toEqual([b.locationId]);

		// Public endpoints with B's publishable key.
		expect((await call('GET', `/v1/public/payment_intents/${pi.id}/status`, { key: b.keys.pk })).status).toBe(404);
		expect((await call('POST', `/v1/public/payment_intents/${pi.id}/claim`, { key: b.keys.pk })).status).toBe(404);

		// B's phone sending A's exact amount can't pay A's intent.
		await sendSignal(b.device, pi.unique_amount);
		const after = await call('GET', `/v1/payment_intents/${pi.id}`, { key: a.keys.sk });
		expect(after.json.status).toBe('pending');
		// A's objects are untouched.
		expect((await call('GET', `/v1/signals/${sig}`, { key: a.keys.sk })).json.status).toBe('unmatched');
		expect((await call('GET', `/v1/signals/${reviewSig}`, { key: a.keys.sk })).json.status).toBe('review');
	});

	it('webhook endpoints are per merchant', async () => {
		const a = await setup();
		const b = await setup();
		await call('POST', '/v1/webhook_endpoints', { key: a.keys.sk, body: { url: 'https://a.example/hook', events: ['*'] } });
		const list = await call('GET', '/v1/webhook_endpoints', { key: b.keys.sk });
		expect(list.json.data).toHaveLength(0);
	});

	it('admin API needs the operator token', async () => {
		expect((await call('POST', '/admin/v1/merchants', { body: { name: 'x' } })).status).toBe(401);
		expect((await call('POST', '/admin/v1/merchants', { key: 'wrong', body: { name: 'x' } })).status).toBe(401);
	});
});

describe('webhook delivery', () => {
	it('signs deliveries, records them, and retries failures with backoff', async () => {
		const { keys, device } = await setup();
		const ep = await call('POST', '/v1/webhook_endpoints', { key: keys.sk, body: { url: 'https://merchant.example/hook', events: ['payment_intent.paid'] } });
		expect(ep.status).toBe(201);
		expect(ep.json.secret).toMatch(/^whsec_/);
		expect((await call('POST', '/v1/webhook_endpoints', { key: keys.sk, body: { url: 'http://insecure.example', events: ['*'] } })).status).toBe(400);

		const seen: { url: string; sig: string | null; body: string }[] = [];
		let reply = 200;
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			seen.push({ url: String(input), sig: new Headers(init?.headers).get('autoconfirm-signature'), body: String(init?.body) });
			return new Response('ok', { status: reply });
		});
		try {
			const pi = (await createIntent(keys.sk)).json;
			await sendSignal(device, pi.unique_amount);
			const ev = await env.DB.prepare("SELECT id FROM events WHERE merchant_id = ? AND type = 'payment_intent.paid'").bind(keys.merchantId).first<{ id: string }>();

			// Deliver one message to the endpoint directly.
			const run = async (attempts: number) => {
				const batch = createMessageBatch('autoconfirm-webhooks', [
					{ id: `m${attempts}`, timestamp: new Date(), attempts, body: { eventId: ev!.id, merchantId: keys.merchantId, endpointId: ep.json.id } },
				]);
				const ctx = createExecutionContext();
				await worker.queue(batch, env);
				return getQueueResult(batch, ctx);
			};

			const ok = await run(1);
			expect(ok.explicitAcks).toEqual(['m1']);
			const delivered = seen.find((s) => s.url === 'https://merchant.example/hook')!;
			expect(await verifyWebhook(ep.json.secret, delivered.body, delivered.sig, Math.floor(Date.now() / 1000))).toBe(true);
			expect(JSON.parse(delivered.body)).toMatchObject({ id: ev!.id, type: 'payment_intent.paid', data: { object: { id: pi.id, status: 'paid' } } });

			reply = 500;
			const before = Date.now();
			const fail = await run(1);
			expect(fail.retryMessages.map((m) => m.msgId)).toEqual(['m1']);
			const pending = await env.DB.prepare("SELECT next_attempt_at FROM webhook_deliveries WHERE merchant_id = ? AND status = 'pending'")
				.bind(keys.merchantId)
				.first<{ next_attempt_at: number }>();
			expect(pending!.next_attempt_at - before).toBeGreaterThanOrEqual(10_000); // first retry after 10 s
			expect(pending!.next_attempt_at - before).toBeLessThan(15_000);
			const last = await run(7);
			expect(last.explicitAcks).toEqual(['m7']); // gives up after the last retry
			const rows = await env.DB.prepare('SELECT status FROM webhook_deliveries WHERE merchant_id = ? ORDER BY id').bind(keys.merchantId).all<{ status: string }>();
			expect(rows.results.map((r) => r.status)).toContain('succeeded');
			expect(rows.results.map((r) => r.status)).toContain('failed');
		} finally {
			spy.mockRestore();
		}
	});
});

describe('payer names', () => {
	it('are shortened to first name + initial, without titles', () => {
		expect(shortPayer('Mr. Vijaykumar Patel')).toBe('Vijaykumar P');
		expect(shortPayer('SMT ANITA SHAH')).toBe('Anita S');
		expect(shortPayer('Ramesh')).toBe('Ramesh');
		expect(shortPayer('Mr.')).toBe('Mr.');
		expect(shortPayer('  ')).toBeNull();
	});
});
