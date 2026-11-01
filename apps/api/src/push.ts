// Push alerts to dashboard users' browsers (Web Push, VAPID). Live-mode events only; sent through the
// webhook queue so a busy push service is retried. Payloads are end-to-end encrypted to the browser.
import { encryptPush, vapidAuthorization, vapidPublicKey } from '@autoconfirm/core';
import type { Env } from './env.ts';

export interface PushNotice {
	title: string;
	body: string;
	/** Dashboard path opened when the alert is tapped. */
	url: string;
	/** Same tag replaces the earlier alert (e.g. "back online" replaces "offline"). */
	tag: string;
}

export interface PushTarget {
	endpoint: string;
	p256dh: string;
	auth: string;
}

interface EventObject {
	id: string;
	label?: string;
	location_id?: string;
	display_amount?: string;
	reason?: string | null;
	likely_walk_in?: boolean;
}

/** The browser-facing public key, or null when push is off (or the key is unusable). */
export function pushPublicKey(env: Env): string | null {
	if (!env.VAPID_PRIVATE_KEY) return null;
	try {
		return vapidPublicKey(env.VAPID_PRIVATE_KEY);
	} catch {
		return null;
	}
}

/** Does this event become a push alert? Walk-ins and resolved signals don't. */
export function wantsPush(type: string, object: EventObject): boolean {
	if (type === 'device.offline' || type === 'device.online' || type === 'signal.review_required') return true;
	return type === 'signal.unmatched' && !object.likely_walk_in && (object.reason === 'no_match' || object.reason === 'ambiguous');
}

export async function noticeFor(env: Env, merchantId: string, type: string, o: EventObject): Promise<PushNotice | null> {
	if (!wantsPush(type, o)) return null;
	if (type === 'device.offline' || type === 'device.online') {
		const loc = await env.DB.prepare('SELECT name FROM locations WHERE id = ? AND merchant_id = ?').bind(o.location_id ?? '', merchantId).first<{ name: string }>();
		const where = loc?.name ?? 'Counter';
		return type === 'device.offline'
			? { title: `📵 Phone offline: ${o.label}`, body: `${where}: payments won't be confirmed automatically. Check its battery, internet and notification access.`, url: '/locations', tag: `device-${o.id}` }
			: { title: `✅ Phone back online: ${o.label}`, body: `${where}: payments are confirmed automatically again.`, url: '/locations', tag: `device-${o.id}` };
	}
	if (type === 'signal.review_required') {
		return { title: `Confirm payment: ₹${o.display_amount}`, body: 'Above your auto-confirm limit. Check the phone or soundbox, then confirm in the inbox.', url: '/inbox', tag: `signal-${o.id}` };
	}
	return {
		title: `Payment needs a look: ₹${o.display_amount}`,
		body: o.reason === 'ambiguous' ? 'More than one order could match. Pick the right one in the inbox.' : "It didn't match an order automatically (for example a different amount). Match it in the inbox.",
		url: '/inbox',
		tag: `signal-${o.id}`,
	};
}

/** Sends one push. Returns the push service's HTTP status (201 = accepted, 404/410 = subscription gone). */
export async function sendPush(env: Env, to: PushTarget, notice: PushNotice): Promise<number> {
	if (!env.VAPID_PRIVATE_KEY) throw new Error('push not configured');
	const subject = env.DASHBOARD_URL || 'mailto:alerts@example.com';
	const body = await encryptPush(to.p256dh, to.auth, JSON.stringify(notice));
	const res = await fetch(to.endpoint, {
		method: 'POST',
		headers: {
			authorization: await vapidAuthorization(env.VAPID_PRIVATE_KEY, to.endpoint, subject),
			'content-encoding': 'aes128gcm',
			'content-type': 'application/octet-stream',
			ttl: '3600',
			urgency: 'high',
			topic: notice.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
		},
		body,
		signal: AbortSignal.timeout(10_000),
	});
	await res.body?.cancel();
	return res.status;
}
