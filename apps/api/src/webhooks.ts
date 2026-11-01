// Webhook delivery through Cloudflare Queues. Signed with AutoConfirm-Signature: t=,v1= (API.md §6).
import { decryptSecret, signWebhook } from '@autoconfirm/core';
import type { Env, WebhookMessage } from './env.ts';
import { noticeFor, pushPublicKey, sendPush, wantsPush } from './push.ts';

/** Push alerts are only useful soon after the event: retry for a few minutes, then drop. */
const PUSH_RETRY_SECONDS = [10, 60, 300];

/** Delay before retry n (after attempt n failed): 10 s, 1 m, 5 m, 30 m, 2 h, 12 h. Then failed. */
export const RETRY_DELAYS_SECONDS = [10, 60, 300, 1800, 7200, 43200];
const TIMEOUT_MS = 10_000;

interface EndpointRow {
	id: string;
	url: string;
	events: string;
	secret_enc: string;
}

function subscribed(eventsJson: string, type: string): boolean {
	try {
		const list = JSON.parse(eventsJson) as unknown;
		return Array.isArray(list) && (list.includes('*') || list.includes(type));
	} catch {
		return false;
	}
}

export async function handleWebhookBatch(batch: MessageBatch<WebhookMessage>, env: Env): Promise<void> {
	for (const msg of batch.messages) {
		try {
			await handleOne(msg, env);
		} catch (err) {
			console.error('webhook handler error', err instanceof Error ? err.message : 'unknown');
			msg.retry({ delaySeconds: RETRY_DELAYS_SECONDS[Math.min(msg.attempts - 1, RETRY_DELAYS_SECONDS.length - 1)] });
		}
	}
}

async function handleOne(msg: Message<WebhookMessage>, env: Env): Promise<void> {
	const { eventId, merchantId, endpointId, pushId } = msg.body;
	const event = await env.DB.prepare('SELECT type, livemode, payload FROM events WHERE id = ? AND merchant_id = ?')
		.bind(eventId, merchantId)
		.first<{ type: string; livemode: number; payload: string }>();
	if (!event) {
		msg.ack();
		return;
	}

	if (pushId) return handlePush(msg, env, event);

	// Fan out: one message per subscribed endpoint (and per push-alert browser), so each retries on its own.
	if (!endpointId) {
		const eps = await env.DB.prepare('SELECT id, events FROM webhook_endpoints WHERE merchant_id = ? AND livemode = ? AND enabled = 1')
			.bind(merchantId, event.livemode)
			.all<{ id: string; events: string }>();
		const targets = eps.results.filter((e) => subscribed(e.events, event.type));
		const messages: { body: WebhookMessage }[] = targets.map((t) => ({ body: { eventId, merchantId, endpointId: t.id } }));
		if (event.livemode === 1 && pushPublicKey(env) && wantsPush(event.type, eventObject(event.payload))) {
			const subs = await env.DB.prepare(
				'SELECT p.id FROM push_subscriptions p JOIN users u ON u.id = p.user_id AND u.merchant_id = p.merchant_id WHERE p.merchant_id = ? AND u.active = 1 LIMIT 50',
			)
				.bind(merchantId)
				.all<{ id: string }>();
			for (const s of subs.results) messages.push({ body: { eventId, merchantId, pushId: s.id } });
		}
		for (let k = 0; k < messages.length; k += 100) await env.WEBHOOKS.sendBatch(messages.slice(k, k + 100));
		msg.ack();
		return;
	}

	const ep = await env.DB.prepare('SELECT id, url, events, secret_enc FROM webhook_endpoints WHERE id = ? AND merchant_id = ? AND enabled = 1')
		.bind(endpointId, merchantId)
		.first<EndpointRow>();
	if (!ep) {
		msg.ack();
		return;
	}

	const secret = await decryptSecret(env.WEBHOOK_KEY, ep.secret_enc);
	const now = Date.now();
	const signature = await signWebhook(secret, event.payload, Math.floor(now / 1000));
	let httpStatus: number | null = null;
	let error: string | null = null;
	try {
		const res = await fetch(ep.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'autoconfirm-signature': signature, 'user-agent': 'AutoConfirm-Webhooks/1' },
			body: event.payload,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		httpStatus = res.status;
		await res.body?.cancel();
	} catch (err) {
		error = err instanceof Error ? err.name : 'fetch_failed';
	}

	const ok = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
	const finalAttempt = msg.attempts > RETRY_DELAYS_SECONDS.length;
	const delay = RETRY_DELAYS_SECONDS[msg.attempts - 1];
	const status = ok ? 'succeeded' : finalAttempt ? 'failed' : 'pending';
	await env.DB.prepare(
		`INSERT INTO webhook_deliveries (merchant_id, event_id, endpoint_id, attempt, status, http_status, error, next_attempt_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(merchantId, eventId, ep.id, msg.attempts, status, httpStatus, error, status === 'pending' && delay ? now + delay * 1000 : null, now)
		.run();

	if (ok || finalAttempt) msg.ack();
	else msg.retry({ delaySeconds: delay ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1] });
}

function eventObject(payload: string) {
	try {
		return (JSON.parse(payload) as { data: { object: { id: string } } }).data.object;
	} catch {
		return { id: '' };
	}
}

async function handlePush(msg: Message<WebhookMessage>, env: Env, event: { type: string; payload: string }): Promise<void> {
	const { merchantId, pushId } = msg.body;
	const sub = await env.DB.prepare(
		'SELECT p.id, p.endpoint, p.p256dh, p.auth FROM push_subscriptions p JOIN users u ON u.id = p.user_id AND u.merchant_id = p.merchant_id WHERE p.id = ? AND p.merchant_id = ? AND u.active = 1',
	)
		.bind(pushId, merchantId)
		.first<{ id: string; endpoint: string; p256dh: string; auth: string }>();
	const notice = sub && env.VAPID_PRIVATE_KEY ? await noticeFor(env, merchantId, event.type, eventObject(event.payload)) : null;
	if (!sub || !notice) return msg.ack();
	let status: number | null = null;
	try {
		status = await sendPush(env, sub, notice);
	} catch {
		status = null;
	}
	if (status !== null && status >= 200 && status < 300) {
		await env.DB.prepare('UPDATE push_subscriptions SET last_sent_at = ? WHERE id = ?').bind(Date.now(), sub.id).run();
		return msg.ack();
	}
	if (status === 404 || status === 410) {
		// The browser unsubscribed or the subscription expired.
		await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ? AND merchant_id = ?').bind(sub.id, merchantId).run();
		return msg.ack();
	}
	const retryable = status === null || status === 429 || status >= 500;
	if (retryable && msg.attempts <= PUSH_RETRY_SECONDS.length) return msg.retry({ delaySeconds: PUSH_RETRY_SECONDS[msg.attempts - 1] });
	console.error('push alert dropped', status ?? 'network');
	msg.ack();
}

