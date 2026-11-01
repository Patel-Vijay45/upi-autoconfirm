// Phone-offline alerts. A phone checks in every 5 min; after OFFLINE_AFTER_MS without one it is marked
// offline once and `device.offline` is sent (webhooks + push). The next check-in sends `device.online`.
// Runs from the 5-minute cron, and right away when a payment is created at a counter with no online phone.
import { randomId } from '@autoconfirm/core';
import type { Context } from 'hono';
import type { Env } from './env.ts';
import { insertEventStmt, type DeviceRow } from './db.ts';
import { iso } from './present.ts';

export const OFFLINE_AFTER_MS = 11 * 60_000;

type AlertDevice = Pick<DeviceRow, 'id' | 'merchant_id' | 'location_id' | 'livemode' | 'label' | 'last_heartbeat_at'>;

export function isOnline(d: Pick<DeviceRow, 'status' | 'last_heartbeat_at'>, now: number): boolean {
	return d.status !== 'revoked' && d.last_heartbeat_at !== null && now - d.last_heartbeat_at < OFFLINE_AFTER_MS;
}

async function emitDeviceEvent(env: Env, d: AlertDevice, type: 'device.offline' | 'device.online', now: number) {
	const id = randomId('evt');
	const livemode = d.livemode === 1;
	const object = {
		id: d.id,
		object: 'device',
		label: d.label,
		location_id: d.location_id,
		livemode,
		status: type === 'device.offline' ? 'offline' : 'online',
		last_heartbeat_at: iso(d.last_heartbeat_at),
	};
	const payload = JSON.stringify({ id, object: 'event', type, created: iso(now), livemode, data: { object } });
	await insertEventStmt(env.DB, { id, merchantId: d.merchant_id, livemode, type, objectId: d.id, payload, createdAt: now }).run();
	await env.WEBHOOKS.send({ eventId: id, merchantId: d.merchant_id });
}

/** Mark these phones offline (only those still 'online') and send one `device.offline` each. */
export async function markOffline(env: Env, devices: AlertDevice[], now: number): Promise<number> {
	let n = 0;
	for (const d of devices) {
		const r = await env.DB.prepare("UPDATE devices SET status = 'offline' WHERE id = ? AND merchant_id = ? AND status = 'online'").bind(d.id, d.merchant_id).run();
		if (r.meta.changes === 1) {
			await emitDeviceEvent(env, d, 'device.offline', now);
			n++;
		}
	}
	return n;
}

/** Cron: every phone that stopped checking in. */
export async function checkOfflinePhones(env: Env, now = Date.now()): Promise<number> {
	const rows = await env.DB.prepare(
		"SELECT id, merchant_id, location_id, livemode, label, last_heartbeat_at FROM devices WHERE status = 'online' AND last_heartbeat_at < ? LIMIT 500",
	)
		.bind(now - OFFLINE_AFTER_MS)
		.all<AlertDevice>();
	return markOffline(env, rows.results, now);
}

/** A check-in from a phone that was marked offline. */
export async function backOnline(env: Env, d: AlertDevice, now: number) {
	await emitDeviceEvent(env, { ...d, last_heartbeat_at: now }, 'device.online', now);
}

/**
 * Is any phone at this counter online? If not, alert now for phones that went quiet since the last cron run
 * (a customer is about to pay and nothing would confirm it).
 */
export async function counterPhoneOnline(env: Env, merchantId: string, locationId: string, livemode: boolean, now: number): Promise<{ online: boolean; stale: AlertDevice[] }> {
	const rows = await env.DB.prepare(
		"SELECT id, merchant_id, location_id, livemode, label, status, last_heartbeat_at FROM devices WHERE merchant_id = ? AND location_id = ? AND livemode = ? AND status IN ('online', 'offline')",
	)
		.bind(merchantId, locationId, livemode ? 1 : 0)
		.all<AlertDevice & { status: DeviceRow['status'] }>();
	const online = rows.results.some((d) => isOnline(d, now));
	return { online, stale: online ? [] : rows.results.filter((d) => d.status === 'online') };
}

/** Returns whether a phone at the counter is online; if none is, sends `device.offline` for phones that just went quiet. */
export async function alertIfCounterOffline<E extends { Bindings: Env }>(c: Context<E>, merchantId: string, locationId: string, livemode: boolean, now: number): Promise<boolean> {
	const { online, stale } = await counterPhoneOnline(c.env, merchantId, locationId, livemode, now);
	if (stale.length) {
		const job = markOffline(c.env, stale, now).catch(() => 0);
		let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
		try {
			ctx = c.executionCtx;
		} catch {
			ctx = undefined; // no execution context (tests)
		}
		if (ctx) ctx.waitUntil(job);
		else await job;
	}
	return online;
}
