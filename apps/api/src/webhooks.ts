// Webhook delivery through Cloudflare Queues. Signed with AutoConfirm-Signature: t=,v1= (API.md §6).
import { decryptSecret, signWebhook } from '@autoconfirm/core';
import type { Env, WebhookMessage } from './env.ts';

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
	const { eventId, merchantId, endpointId } = msg.body;
	const event = await env.DB.prepare('SELECT type, livemode, payload FROM events WHERE id = ? AND merchant_id = ?')
		.bind(eventId, merchantId)
		.first<{ type: string; livemode: number; payload: string }>();
	if (!event) {
		msg.ack();
		return;
	}

	// Fan out: one message per subscribed endpoint, so each endpoint retries on its own.
	if (!endpointId) {
		const eps = await env.DB.prepare('SELECT id, events FROM webhook_endpoints WHERE merchant_id = ? AND livemode = ? AND enabled = 1')
			.bind(merchantId, event.livemode)
			.all<{ id: string; events: string }>();
		const targets = eps.results.filter((e) => subscribed(e.events, event.type));
		if (targets.length) await env.WEBHOOKS.sendBatch(targets.map((t) => ({ body: { eventId, merchantId, endpointId: t.id } })));
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
