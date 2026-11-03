import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { totpAt, totpStep } from '@autoconfirm/core';
import worker from '../src/index.ts';
import type { WebhookMessage } from '../src/env.ts';
import { checkOfflinePhones } from '../src/alerts.ts';
import { ADMIN, call, createIntent, deviceCall, sendSignal, setup } from './helpers.ts';

let n = 0;
async function owner(merchantId: string) {
	const inv = await call('POST', `/admin/v1/merchants/${merchantId}/invites`, { key: ADMIN, body: { email: `prj${++n}@shop.example`, role: 'owner' } });
	const info = await call('GET', `/dashboard/v1/invites/${inv.json.token}`);
	const done = await call('POST', `/dashboard/v1/invites/${inv.json.token}`, { body: { password: 'correct horse battery', otp: await totpAt(info.json.totp.secret, totpStep(Date.now())) } });
	return { key: done.json.token as string, headers: { 'autoconfirm-mode': 'test' } };
}

/** A shop with two projects (a store and a café) on one counter / UPI ID, each with its own keys. */
async function shopWithProjects() {
	const s = await setup();
	const o = await owner(s.keys.merchantId);
	const store = (await call('POST', '/v1/projects', { ...o, body: { name: 'Online store' } })).json;
	const cafe = (await call('POST', '/v1/projects', { ...o, body: { name: 'Café' } })).json;
	const key = async (projectId: string, kind = 'secret') => (await call('POST', '/v1/api_keys', { ...o, body: { kind, project_id: projectId } })).json.key as string;
	return { ...s, o, store, cafe, storeKey: await key(store.id), cafeKey: await key(cafe.id), storePk: await key(store.id, 'publishable') };
}

async function fanOut(eventId: string, merchantId: string) {
	const sent: WebhookMessage[] = [];
	const spy = vi.spyOn(env.WEBHOOKS, 'sendBatch').mockImplementation(async (msgs) => {
		for (const m of msgs as { body: WebhookMessage }[]) sent.push(m.body);
		return undefined as never;
	});
	const batch = createMessageBatch<WebhookMessage>('autoconfirm-webhooks', [{ id: 'm1', timestamp: new Date(), attempts: 1, body: { eventId, merchantId } }]);
	const ctx = createExecutionContext();
	await worker.queue(batch, env);
	await getQueueResult(batch, ctx);
	spy.mockRestore();
	return sent.map((m) => m.endpointId).filter(Boolean).sort();
}

afterEach(() => vi.restoreAllMocks());

describe('projects', () => {
	it("a project's key creates and sees only its own payments; amounts stay unique across projects", async () => {
		const p = await shopWithProjects();
		const a = (await createIntent(p.storeKey, { amount: 50000, order_id: 'S-1' })).json;
		const b = (await createIntent(p.cafeKey, { amount: 50000, order_id: 'C-1' })).json;
		expect(a.project_id).toBe(p.store.id);
		expect(b.project_id).toBe(p.cafe.id);
		expect(a.unique_amount).not.toBe(b.unique_amount); // one UPI ID, one pool of amounts
		const storeList = await call('GET', '/v1/payment_intents', { key: p.storeKey });
		expect(storeList.json.data.map((x: { id: string }) => x.id)).toEqual([a.id]);
		for (const [m, path] of [
			['GET', `/v1/payment_intents/${b.id}`],
			['POST', `/v1/payment_intents/${b.id}/cancel`],
			['POST', `/v1/payment_intents/${b.id}/mark_paid`],
		] as const) {
			expect((await call(m, path, { key: p.storeKey, body: m === 'POST' ? {} : undefined })).status, path).toBe(404);
		}
		// The store's publishable key can't show the café's payment either.
		expect((await call('GET', `/v1/public/payment_intents/${b.id}`, { key: p.storePk })).status).toBe(404);
		expect((await call('GET', `/v1/public/payment_intents/${a.id}`, { key: p.storePk })).status).toBe(200);
		// The shop-wide key sees both, and can filter.
		expect((await call('GET', '/v1/payment_intents', { key: p.keys.sk })).json.data).toHaveLength(2);
		expect((await call('GET', `/v1/payment_intents?project_id=${p.cafe.id}`, { key: p.keys.sk })).json.data.map((x: { id: string }) => x.id)).toEqual([b.id]);
		// A shop-wide key may put a payment in a project; a project key can't pick another project.
		expect((await createIntent(p.keys.sk, { amount: 70000, project_id: p.cafe.id })).json.project_id).toBe(p.cafe.id);
		expect((await createIntent(p.storeKey, { amount: 70000, project_id: p.cafe.id })).status).toBe(403);
	});

	it('project keys are kept out of shop-level things', async () => {
		const p = await shopWithProjects();
		for (const [m, path, body] of [
			['GET', '/v1/signals', undefined],
			['POST', '/v1/locations', { name: 'X', upi_vpa: 'x@ybl', upi_payee_name: 'X' }],
			['POST', `/v1/locations/${p.locationId}/pairing_codes`, undefined],
			['GET', '/v1/projects', undefined],
			['POST', '/v1/projects', { name: 'Sneaky' }],
			['GET', '/v1/reports/summary', undefined],
			['GET', '/v1/devices', undefined],
		] as const) {
			const r = await call(m, path, { key: p.storeKey, body });
			expect(r.status, `${m} ${path}`).toBe(403);
			expect(r.json.error.code).toBe('project_key_scope');
		}
		expect((await call('GET', '/v1/locations', { key: p.storeKey })).status).toBe(200);
		// Unmatched shop money can't be pulled into a project's order by its key.
		const pi = (await createIntent(p.storeKey, { amount: 50000 })).json;
		const sig = (await sendSignal(p.device, 49000)).json.results[0].signal_id;
		expect((await call('POST', `/v1/payment_intents/${pi.id}/mark_paid`, { key: p.storeKey, body: { signal_id: sig } })).status).toBe(403);
	});

	it('the same Idempotency-Key in two projects makes two payments', async () => {
		const p = await shopWithProjects();
		const headers = { 'idempotency-key': 'order-1' };
		const a = await createIntent(p.storeKey, { amount: 50000 }, headers);
		const b = await createIntent(p.cafeKey, { amount: 50000 }, headers);
		expect(a.json.id).not.toBe(b.json.id);
		expect((await createIntent(p.storeKey, { amount: 50000 }, headers)).json.id).toBe(a.json.id);
	});

	it("webhooks: a project's endpoint gets its own payments and phone status, never other projects' or the inbox", async () => {
		const p = await shopWithProjects();
		const ep = async (key: string, project?: string) =>
			(await call('POST', '/v1/webhook_endpoints', { key, body: { url: 'https://hooks.example/x', events: ['*'], ...(project ? { project_id: project } : {}) } })).json;
		const shopWide = await ep(p.keys.sk);
		const storeEp = await ep(p.storeKey);
		const cafeEp = await ep(p.keys.sk, p.cafe.id);
		expect(storeEp.project_id).toBe(p.store.id);
		expect((await call('GET', '/v1/webhook_endpoints', { key: p.storeKey })).json.data.map((e: { id: string }) => e.id)).toEqual([storeEp.id]);
		// The store's key can't switch off the café's endpoint.
		expect((await call('POST', `/v1/webhook_endpoints/${cafeEp.id}/disable`, { key: p.storeKey })).status).toBe(404);

		const pi = (await createIntent(p.storeKey, { amount: 50000 })).json;
		await sendSignal(p.device, pi.unique_amount);
		const paid = await env.DB.prepare("SELECT id FROM events WHERE merchant_id = ? AND type = 'payment_intent.paid'").bind(p.keys.merchantId).first<{ id: string }>();
		expect(await fanOut(paid!.id, p.keys.merchantId)).toEqual([shopWide.id, storeEp.id].sort());

		await sendSignal(p.device, 6000); // money for no order: shop inbox, shop-wide endpoint only
		const unmatched = await env.DB.prepare("SELECT id FROM events WHERE merchant_id = ? AND type = 'signal.unmatched'").bind(p.keys.merchantId).first<{ id: string }>();
		expect(await fanOut(unmatched!.id, p.keys.merchantId)).toEqual([shopWide.id]);

		await deviceCall(p.device, 'POST', '/device/v1/heartbeat', { listener_connected: true, device_time: Date.now() });
		await env.DB.prepare('UPDATE devices SET last_heartbeat_at = ? WHERE id = ?').bind(Date.now() - 12 * 60_000, p.device.id).run();
		await checkOfflinePhones(env);
		const offline = await env.DB.prepare("SELECT id FROM events WHERE merchant_id = ? AND type = 'device.offline'").bind(p.keys.merchantId).first<{ id: string }>();
		expect(await fanOut(offline!.id, p.keys.merchantId)).toEqual([shopWide.id, storeEp.id, cafeEp.id].sort());

		// Event lists follow the same rule.
		const storeEvents = (await call('GET', '/v1/events', { key: p.storeKey })).json.data.map((e: { type: string }) => e.type);
		expect(storeEvents).toContain('payment_intent.paid');
		expect(storeEvents).not.toContain('signal.unmatched');
		expect((await call('GET', '/v1/events', { key: p.cafeKey })).json.data.filter((e: { type: string }) => e.type.startsWith('payment_intent.'))).toHaveLength(0);
	});

	it('a paused project stops its keys; reports split by project', async () => {
		const p = await shopWithProjects();
		const a = (await createIntent(p.storeKey, { amount: 50000 })).json;
		await sendSignal(p.device, a.unique_amount);
		const b = (await createIntent(p.cafeKey, { amount: 30000 })).json;
		await sendSignal(p.device, b.unique_amount);
		const store = await call('GET', `/v1/reports/summary?project_id=${p.store.id}`, p.o);
		expect(store.json.total).toMatchObject({ paid_count: 1, received: a.unique_amount });
		expect((await call('GET', '/v1/reports/summary', p.o)).json.total.paid_count).toBe(2);
		const csv = await (await import('../src/app.ts')).app.request('/v1/reports/payments.csv', { headers: { authorization: `Bearer ${p.o.key}`, 'autoconfirm-mode': 'test' } }, env);
		expect(await csv.text()).toContain(',Café');

		expect((await call('POST', `/v1/projects/${p.cafe.id}`, { ...p.o, body: { active: false } })).json.active).toBe(false);
		expect((await createIntent(p.cafeKey, { amount: 30000 })).status).toBe(401);
		expect((await createIntent(p.keys.sk, { amount: 30000, project_id: p.cafe.id })).json.error.code).toBe('project_paused');
	});

	it("tenancy: another merchant can't see, change or use these projects", async () => {
		const a = await shopWithProjects();
		const b = await setup();
		const bOwner = await owner(b.keys.merchantId);
		expect((await call('GET', '/v1/projects', bOwner)).json.data).toHaveLength(0);
		expect((await call('POST', `/v1/projects/${a.store.id}`, { ...bOwner, body: { name: 'Mine now' } })).status).toBe(404);
		expect((await call('POST', '/v1/api_keys', { ...bOwner, body: { kind: 'secret', project_id: a.store.id } })).status).toBe(404);
		expect((await createIntent(b.keys.sk, { project_id: a.store.id })).status).toBe(404);
		expect((await call('POST', '/v1/webhook_endpoints', { key: b.keys.sk, body: { url: 'https://hooks.example/x', events: ['*'], project_id: a.store.id } })).status).toBe(404);
		expect((await call('GET', '/v1/projects', a.o)).json.data.map((x: { name: string }) => x.name)).toEqual(['Online store', 'Café']);
	});
});
