import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { checkOfflinePhones } from '../src/alerts.ts';
import { totpAt, totpStep } from '@autoconfirm/core';
import { ADMIN, call, createIntent, deviceCall, setup } from './helpers.ts';

const heartbeat = (device: Parameters<typeof deviceCall>[0]) =>
	deviceCall(device, 'POST', '/device/v1/heartbeat', { listener_connected: true, app_version: '0.1.3', queue_size: 0, battery_optimized: false, device_time: Date.now() });

async function events(merchantId: string, type: string) {
	const r = await env.DB.prepare('SELECT payload FROM events WHERE merchant_id = ? AND type = ? ORDER BY created_at').bind(merchantId, type).all<{ payload: string }>();
	return r.results.map((e) => JSON.parse(e.payload));
}

/** Pretend the phone's last check-in was `ms` ago. */
const age = (deviceId: string, ms: number) => env.DB.prepare('UPDATE devices SET last_heartbeat_at = ? WHERE id = ?').bind(Date.now() - ms, deviceId).run();

describe('phone-offline alerts', () => {
	it('the 5-minute job alerts once when a phone stops checking in, and again when it is back', async () => {
		const { keys, device, locationId } = await setup();
		expect((await heartbeat(device)).status).toBe(200);
		await checkOfflinePhones(env);
		expect(await events(keys.merchantId, 'device.offline')).toHaveLength(0); // just checked in

		await age(device.id, 12 * 60_000);
		await checkOfflinePhones(env);
		await checkOfflinePhones(env); // no second alert for the same outage
		const off = await events(keys.merchantId, 'device.offline');
		expect(off).toHaveLength(1);
		expect(off[0].data.object).toMatchObject({ id: device.id, object: 'device', status: 'offline', location_id: locationId, livemode: false });
		const row = await env.DB.prepare('SELECT status FROM devices WHERE id = ?').bind(device.id).first<{ status: string }>();
		expect(row!.status).toBe('offline');

		await heartbeat(device);
		const on = await events(keys.merchantId, 'device.online');
		expect(on).toHaveLength(1);
		expect(on[0].data.object).toMatchObject({ id: device.id, status: 'online' });
		await heartbeat(device);
		expect(await events(keys.merchantId, 'device.online')).toHaveLength(1);
	});

	it('a new payment at a counter whose phone went quiet alerts at once; the customer page knows', async () => {
		const { keys, device } = await setup();
		await heartbeat(device);
		await age(device.id, 12 * 60_000); // quiet, but the job hasn't run yet
		const pi = (await createIntent(keys.sk)).json;
		expect(await events(keys.merchantId, 'device.offline')).toHaveLength(1);
		expect((await call('POST', `/p/${pi.id}/claim`)).json).toMatchObject({ status: 'pending', phone_offline: true });
		await heartbeat(device);
		expect((await call('POST', `/p/${pi.id}/claim`)).json.phone_offline).toBe(false);
	});

	it('removed phones and phones that never checked in are not alerted', async () => {
		const { keys, device } = await setup();
		await checkOfflinePhones(env); // paired but never checked in: status pending
		await heartbeat(device);
		await call('POST', `/v1/devices/${device.id}/revoke`, { key: keys.sk });
		await age(device.id, 60 * 60_000);
		await checkOfflinePhones(env);
		expect(await events(keys.merchantId, 'device.offline')).toHaveLength(0);
	});

	it('the dashboard banner lists only this shop\'s offline phones', async () => {
		const a = await setup();
		const b = await setup();
		for (const shop of [a, b]) {
			await heartbeat(shop.device);
			await age(shop.device.id, 12 * 60_000);
		}
		const inv = await call('POST', `/admin/v1/merchants/${a.keys.merchantId}/invites`, { key: ADMIN, body: { email: `banner${Date.now()}@shop.example`, role: 'owner' } });
		const info = await call('GET', `/dashboard/v1/invites/${inv.json.token}`);
		const done = await call('POST', `/dashboard/v1/invites/${inv.json.token}`, { body: { password: 'correct horse battery', otp: await totpAt(info.json.totp.secret, totpStep(Date.now())) } });
		const me = await call('GET', '/dashboard/v1/me', { key: done.json.token, headers: { 'autoconfirm-mode': 'test' } });
		expect(me.json.phones_offline).toEqual([expect.objectContaining({ id: a.device.id, label: 'Counter phone', location_name: 'Counter 1' })]);
		await heartbeat(a.device);
		expect((await call('GET', '/dashboard/v1/me', { key: done.json.token, headers: { 'autoconfirm-mode': 'test' } })).json.phones_offline).toEqual([]);
	});
});
