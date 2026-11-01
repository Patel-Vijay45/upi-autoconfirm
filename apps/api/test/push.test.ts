import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { b64url, totpAt, totpStep } from '@autoconfirm/core';
import worker from '../src/index.ts';
import type { WebhookMessage } from '../src/env.ts';
import { checkOfflinePhones } from '../src/alerts.ts';
import { ADMIN, call, deviceCall, newLocation, newMerchant, pairDevice, sendSignal, type Device } from './helpers.ts';

const enc = new TextEncoder();
let n = 0;

async function session(merchantId: string, role: 'owner' | 'staff' = 'staff') {
	const inv = await call('POST', `/admin/v1/merchants/${merchantId}/invites`, { key: ADMIN, body: { email: `push${++n}@shop.example`, role } });
	const info = await call('GET', `/dashboard/v1/invites/${inv.json.token}`);
	const otp = role === 'owner' ? await totpAt(info.json.totp.secret, totpStep(Date.now())) : undefined;
	const done = await call('POST', `/dashboard/v1/invites/${inv.json.token}`, { body: { password: 'correct horse battery', ...(otp ? { otp } : {}) } });
	return { key: done.json.token as string, userId: done.json.user.id as string };
}

/** A browser: its push keys, and a way to read what we send it. */
async function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
	const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
	const auth = crypto.getRandomValues(new Uint8Array(16));
	const p256dh = new Uint8Array((await crypto.subtle.exportKey('raw', ua.publicKey)) as ArrayBuffer);
	const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) => {
		const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
		return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
	};
	return {
		subscription: { endpoint, keys: { p256dh: b64url(p256dh), auth: b64url(auth) }, label: 'Chrome on Android' },
		async read(body: Uint8Array) {
			const asPublic = body.slice(21, 21 + body[20]!);
			const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
			const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', $public: asKey, public: asKey } as never, ua.privateKey, 256));
			const ikm = await hkdf(auth, shared, new Uint8Array([...enc.encode('WebPush: info\0'), ...p256dh, ...asPublic]), 32);
			const salt = body.slice(0, 16);
			const key = await crypto.subtle.importKey('raw', await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt']);
			const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12) }, key, body.slice(21 + body[20]!)));
			return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
		},
	};
}

/** Run the queue consumer on one message; returns the messages it fanned out. */
async function runQueue(body: Record<string, unknown>, attempts = 1) {
	const sent: { body: Record<string, unknown> }[] = [];
	const spy = vi.spyOn(env.WEBHOOKS, 'sendBatch').mockImplementation(async (msgs) => {
		sent.push(...(msgs as never[]));
		return undefined as never;
	});
	const batch = createMessageBatch<WebhookMessage>('autoconfirm-webhooks', [{ id: 'm1', timestamp: new Date(), attempts, body: body as unknown as WebhookMessage }]);
	const ctx = createExecutionContext();
	await worker.queue(batch, env);
	const result = await getQueueResult(batch, ctx);
	spy.mockRestore();
	return { sent: sent.map((m) => m.body), result };
}

async function liveShop() {
	const keys = await newMerchant();
	const locationId = await newLocation(keys.sk);
	const device = await pairDevice(keys.skLive, locationId); // a live phone
	return { keys, locationId, device };
}

async function goOffline(device: Device) {
	await deviceCall(device, 'POST', '/device/v1/heartbeat', { listener_connected: true, device_time: Date.now() });
	await env.DB.prepare('UPDATE devices SET last_heartbeat_at = ? WHERE id = ?').bind(Date.now() - 12 * 60_000, device.id).run();
	await checkOfflinePhones(env);
}

afterEach(() => vi.restoreAllMocks());

describe('push alerts', () => {
	it('a browser subscribes; only dashboard users, only real push services', async () => {
		const { keys } = await liveShop();
		const cfg = await call('GET', '/v1/push/config', { key: keys.sk });
		expect(cfg.json).toMatchObject({ enabled: true, public_key: expect.stringMatching(/^B[A-Za-z0-9_-]{86}$/) });
		const b = await browser();
		expect((await call('POST', '/v1/push_subscriptions', { key: keys.sk, body: b.subscription })).status).toBe(403); // API key: no user
		const staff = await session(keys.merchantId);
		expect((await call('POST', '/v1/push_subscriptions', { key: staff.key, body: { ...b.subscription, endpoint: 'https://evil.example/x' } })).status).toBe(400);
		expect((await call('POST', '/v1/push_subscriptions', { key: staff.key, body: { ...b.subscription, keys: { p256dh: 'abc', auth: 'abc' } } })).status).toBe(400);
		expect((await call('POST', '/v1/push_subscriptions', { key: staff.key, body: b.subscription })).status).toBe(201);
		expect((await call('POST', '/v1/push_subscriptions', { key: staff.key, body: b.subscription })).status).toBe(201); // again: same row
		const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE merchant_id = ?').bind(keys.merchantId).first<{ n: number }>();
		expect(rows!.n).toBe(1);
	});

	it('a live phone going offline reaches the browser, encrypted and VAPID-signed', async () => {
		const { keys, device } = await liveShop();
		const staff = await session(keys.merchantId);
		const b = await browser();
		await call('POST', '/v1/push_subscriptions', { key: staff.key, body: b.subscription });
		await goOffline(device);
		const ev = await env.DB.prepare("SELECT id FROM events WHERE merchant_id = ? AND type = 'device.offline'").bind(keys.merchantId).first<{ id: string }>();

		const fan = await runQueue({ eventId: ev!.id, merchantId: keys.merchantId });
		const push = fan.sent.find((m) => m.pushId);
		expect(push).toBeDefined();

		const seen: { url: string; headers: Headers; body: Uint8Array }[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			seen.push({ url: String(input), headers: new Headers(init?.headers), body: new Uint8Array(init!.body as ArrayBuffer) });
			return new Response(null, { status: 201 });
		});
		const r = await runQueue(push!);
		expect(r.result.explicitAcks).toEqual(['m1']);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.url).toBe(b.subscription.endpoint);
		expect(seen[0]!.headers.get('content-encoding')).toBe('aes128gcm');
		expect(seen[0]!.headers.get('authorization')).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B/);
		expect(await b.read(seen[0]!.body)).toMatchObject({ title: '📵 Phone offline: Counter phone', url: '/locations', tag: `device-${device.id}` });
	});

	it('an expired browser subscription is removed; a busy push service is retried', async () => {
		const { keys, device } = await liveShop();
		const staff = await session(keys.merchantId);
		await call('POST', '/v1/push_subscriptions', { key: staff.key, body: (await browser()).subscription });
		await goOffline(device);
		const ev = await env.DB.prepare("SELECT id FROM events WHERE merchant_id = ? AND type = 'device.offline'").bind(keys.merchantId).first<{ id: string }>();
		const push = (await runQueue({ eventId: ev!.id, merchantId: keys.merchantId })).sent.find((m) => m.pushId)!;
		let status = 503;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status }));
		expect((await runQueue(push)).result.retryMessages).toHaveLength(1);
		status = 410;
		expect((await runQueue(push, 2)).result.explicitAcks).toEqual(['m1']);
		const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE merchant_id = ?').bind(keys.merchantId).first<{ n: number }>();
		expect(rows!.n).toBe(0);
	});

	it('walk-ins and test-mode events are not pushed; deactivated users stop getting alerts', async () => {
		const { keys, device } = await liveShop();
		const staff = await session(keys.merchantId, 'staff');
		const owner = await session(keys.merchantId, 'owner');
		await call('POST', '/v1/push_subscriptions', { key: staff.key, body: (await browser()).subscription });
		await sendSignal(device, 6000); // a walk-in, live
		const walkIn = await env.DB.prepare("SELECT id FROM events WHERE merchant_id = ? AND type = 'signal.unmatched'").bind(keys.merchantId).first<{ id: string }>();
		expect((await runQueue({ eventId: walkIn!.id, merchantId: keys.merchantId })).sent.filter((m) => m.pushId)).toHaveLength(0);

		const testPhone = await pairDevice(keys.sk, device.locationId);
		await goOffline(testPhone);
		const testEv = await env.DB.prepare("SELECT id FROM events WHERE merchant_id = ? AND type = 'device.offline' AND livemode = 0").bind(keys.merchantId).first<{ id: string }>();
		expect((await runQueue({ eventId: testEv!.id, merchantId: keys.merchantId })).sent.filter((m) => m.pushId)).toHaveLength(0);

		await call('POST', `/v1/users/${staff.userId}/deactivate`, { key: owner.key, headers: { 'autoconfirm-mode': 'live' } });
		const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE merchant_id = ?').bind(keys.merchantId).first<{ n: number }>();
		expect(rows!.n).toBe(0);
	});

	it('tenancy: another merchant can neither remove nor test-send to these subscriptions', async () => {
		const a = await liveShop();
		const b = await liveShop();
		const aUser = await session(a.keys.merchantId);
		const bUser = await session(b.keys.merchantId);
		const br = await browser();
		await call('POST', '/v1/push_subscriptions', { key: aUser.key, body: br.subscription });
		await call('POST', '/v1/push_subscriptions/delete', { key: bUser.key, body: { endpoint: br.subscription.endpoint } });
		const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE merchant_id = ?').bind(a.keys.merchantId).first<{ n: number }>();
		expect(rows!.n).toBe(1);
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 201 }));
		expect((await call('POST', '/v1/push_subscriptions/test', { key: bUser.key })).json).toMatchObject({ subscriptions: 0, sent: 0 });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect((await call('POST', '/v1/push_subscriptions/test', { key: aUser.key })).json).toMatchObject({ subscriptions: 1, sent: 1 });
		await call('POST', '/v1/push_subscriptions/delete', { key: aUser.key, body: { endpoint: br.subscription.endpoint } });
		const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE merchant_id = ?').bind(a.keys.merchantId).first<{ n: number }>();
		expect(after!.n).toBe(0);
	});
});
