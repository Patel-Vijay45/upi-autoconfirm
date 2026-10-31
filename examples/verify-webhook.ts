// Verify an AutoConfirm webhook in any runtime with Web Crypto
// (Cloudflare Workers, Deno, Bun, Node 18+, SvelteKit, Next.js route handlers).
//
// Header: AutoConfirm-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>

const TOLERANCE_SECONDS = 300;

export async function verifyAutoConfirmWebhook(
	rawBody: string,
	signatureHeader: string | null,
	secret: string,
	nowSeconds = Math.floor(Date.now() / 1000)
): Promise<boolean> {
	if (!signatureHeader) return false;
	const parts = Object.fromEntries(
		signatureHeader.split(',').map((p) => {
			const i = p.indexOf('=');
			return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
		})
	);
	const t = Number(parts.t);
	const v1 = parts.v1;
	if (!Number.isFinite(t) || !v1) return false;
	if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return false; // stops replays of old events

	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`)));
	const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
	return timingSafeEqual(expected, v1);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// ---- Example: SvelteKit route  src/routes/api/webhooks/autoconfirm/+server.ts ----
// import { json, error } from '@sveltejs/kit';
// export const POST = async ({ request, platform }) => {
//   const raw = await request.text();                               // RAW body: do not JSON.parse before verifying
//   const ok = await verifyAutoConfirmWebhook(raw, request.headers.get('AutoConfirm-Signature'), platform.env.AUTOCONFIRM_WEBHOOK_SECRET);
//   if (!ok) error(400, 'bad signature');
//   const event = JSON.parse(raw);
//   if (event.type === 'payment_intent.paid') {
//     await markOrderPaid(event.data.object.order_id, event.data.object.id, event.id); // idempotent by event.id
//   }
//   return json({ received: true });
// };
