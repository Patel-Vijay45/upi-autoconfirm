// Node.js 18+ / Express: create a payment and handle the webhook.
//   npm i express
//   AUTOCONFIRM_SECRET_KEY=sk_test_xxx AUTOCONFIRM_WEBHOOK_SECRET=whsec_xxx node node-express.mjs
import express from 'express';
import crypto from 'node:crypto';

const API = 'https://api.example.com/v1'; // your AutoConfirm API base URL
const SK = process.env.AUTOCONFIRM_SECRET_KEY;
const WHSEC = process.env.AUTOCONFIRM_WEBHOOK_SECRET;
const app = express();

// --- 1. Create a payment intent for an order (call from your checkout) ---
app.post('/api/create-upi-payment', express.json(), async (req, res) => {
	const order = await loadOrder(req.body.orderId); // your DB
	const r = await fetch(`${API}/payment_intents`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${SK}`,
			'Content-Type': 'application/json',
			'Idempotency-Key': `order-${order.id}` // retries never create a second payment
		},
		body: JSON.stringify({
			amount: order.totalPaise,
			order_id: order.id,
			return_url: `https://yoursite.com/order/${order.id}`
		})
	});
	const intent = await r.json();
	if (!r.ok) return res.status(502).json({ error: intent.error?.message ?? 'payment setup failed' });
	await saveIntentOnOrder(order.id, intent.id, intent.unique_amount);
	res.json({ intentId: intent.id, checkoutUrl: intent.checkout_url, amount: intent.display_amount });
});

// --- 2. Webhook: RAW body is required for signature verification ---
app.post('/webhooks/autoconfirm', express.raw({ type: 'application/json' }), async (req, res) => {
	const raw = req.body.toString('utf8');
	if (!verify(raw, req.get('AutoConfirm-Signature'), WHSEC)) return res.status(400).send('bad signature');
	const event = JSON.parse(raw);

	if (await alreadyProcessed(event.id)) return res.sendStatus(200); // idempotent
	if (event.type === 'payment_intent.paid') {
		const pi = event.data.object;
		const order = await loadOrderByIntent(pi.id);
		if (order && pi.amount === order.totalPaise) await markOrderPaid(order.id, pi.id);
	}
	if (event.type === 'signal.unmatched') await notifyStaff(`Money received but not matched: ₹${event.data.object.amount / 100}`);
	await rememberProcessed(event.id);
	res.sendStatus(200); // reply fast; do slow work in a job queue
});

function verify(raw, header, secret) {
	if (!header) return false;
	const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
	const t = Number(parts.t);
	if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
	const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
	const a = Buffer.from(expected);
	const b = Buffer.from(parts.v1 ?? '');
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- your app's functions (stubs) ---
async function loadOrder(id) { return { id, totalPaise: 93000 }; }
async function loadOrderByIntent(intentId) { return null; }
async function saveIntentOnOrder(orderId, intentId, uniqueAmount) {}
async function markOrderPaid(orderId, intentId) {}
async function alreadyProcessed(eventId) { return false; }
async function rememberProcessed(eventId) {}
async function notifyStaff(msg) { console.log(msg); }

app.listen(3000, () => console.log('listening on :3000'));
