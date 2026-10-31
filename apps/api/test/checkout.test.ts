import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/app.ts';
import { WIDGET_GZIP_BYTES } from '../src/generated/checkout-assets.ts';
import { call, createIntent, sendSignal, setup } from './helpers.ts';

async function page(path: string, headers: Record<string, string> = {}) {
	const res = await app.request(path, { headers }, env);
	return { res, html: await res.text() };
}

/** Open a WebSocket through the Worker and collect its messages. */
async function openLive(path: string) {
	const res = await app.request(path, { headers: { upgrade: 'websocket' } }, env);
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	const messages: any[] = [];
	const waiters: (() => void)[] = [];
	ws.accept();
	ws.addEventListener('message', (e) => {
		messages.push(JSON.parse(String(e.data)));
		waiters.splice(0).forEach((w) => w());
	});
	const next = async (n: number) => {
		while (messages.length < n) await new Promise<void>((r) => waiters.push(r));
		return messages[n - 1];
	};
	return { ws, next };
}

describe('hosted checkout page', () => {
	it('renders the amount, app links, QR and a strict CSP, with no customer data', async () => {
		const { keys } = await setup();
		const pi = (await createIntent(keys.sk, { customer: { name: 'Ramesh Patel', phone: '9800000000' }, return_url: 'https://shop.example/done' })).json;
		const { res, html } = await page(`/p/${pi.id}`);
		expect(res.status).toBe(200);
		expect(html).toContain(`₹${pi.display_amount}`);
		expect(html).toContain(`+${pi.unique_amount - pi.amount} paise`);
		expect(html).toContain('Pay My Shop');
		expect(html).toContain(`href="gpay://upi/pay?pa=shop@ybl&amp;pn=My%20Shop&amp;am=${pi.display_amount}`);
		expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
		expect(html).not.toContain('Ramesh');
		expect(html).not.toContain('9800000000');
		const csp = res.headers.get('content-security-policy')!;
		const n = /script-src 'nonce-([^']+)'/.exec(csp)![1];
		expect(html).toContain(`<script nonce="${n}">`);
		expect(csp).toContain("frame-ancestors 'none'");
		expect(res.headers.get('cache-control')).toBe('no-store');
	});

	it('speaks Hindi and Gujarati', async () => {
		const { keys } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		expect((await page(`/p/${pi.id}?lang=hi`)).html).toContain('मैंने भुगतान कर दिया');
		expect((await page(`/p/${pi.id}`, { 'accept-language': 'gu-IN,gu;q=0.9' })).html).toContain('મેં ચુકવણી કરી દીધી છે');
	});

	it('unknown and malformed ids get a friendly 404 page', async () => {
		expect((await page('/p/pi_aaaaaaaaaaaaaaaaaaaa')).res.status).toBe(404);
		expect((await page('/p/<script>')).res.status).toBe(404);
	});

	it('status, claim and paid state by intent id', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		expect((await call('GET', `/p/${pi.id}/status`)).json).toMatchObject({ status: 'pending', display_amount: pi.display_amount });
		expect((await call('POST', `/p/${pi.id}/claim`)).json.status).toBe('pending');
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk })).json.customer_claimed_at).not.toBeNull();
		await sendSignal(device, pi.unique_amount);
		expect((await call('GET', `/p/${pi.id}/status`)).json.status).toBe('paid');
		const { html } = await page(`/p/${pi.id}`);
		expect(html).toContain('data-status="paid"');
		expect(html).toContain('Payment received ✓');
	});

	it('pushes "paid" over the live WebSocket the moment the phone reports it', async () => {
		const { keys, device } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		const live = await openLive(`/p/${pi.id}/live`);
		expect(await live.next(1)).toMatchObject({ type: 'status', status: 'pending' });
		await sendSignal(device, pi.unique_amount);
		const msg = await live.next(2);
		expect(msg).toMatchObject({ type: 'status', status: 'paid' });
		expect(msg.paid_at).not.toBeNull();
		live.ws.close();
	});

	it('the live endpoint needs a WebSocket upgrade', async () => {
		const { keys } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		expect((await call('GET', `/p/${pi.id}/live`)).status).toBe(426);
	});
});

describe('checkout.js widget', () => {
	it('serves checkout.js under 15 KB gzipped', async () => {
		const res = await app.request('/v1/checkout.js', {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('javascript');
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(await res.text()).toContain('AutoConfirm');
		expect(WIDGET_GZIP_BYTES).toBeLessThan(15 * 1024);
	});

	it('public view with the publishable key, with CORS', async () => {
		const { keys } = await setup();
		const pi = (await createIntent(keys.sk, { customer: { name: 'Ramesh Patel' } })).json;
		const v = await call('GET', `/v1/public/payment_intents/${pi.id}`, { key: keys.pk });
		expect(v.json).toMatchObject({ id: pi.id, status: 'pending', display_amount: pi.display_amount, payee_name: 'My Shop', order_id: 'ORD-1042' });
		expect(v.json.qr_svg).toContain('<svg');
		expect(JSON.stringify(v.json)).not.toContain('Ramesh');
		const pre = await app.request(`/v1/public/payment_intents/${pi.id}`, { method: 'OPTIONS', headers: { origin: 'https://shop.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } }, env);
		expect(pre.status).toBe(204);
		expect(pre.headers.get('access-control-allow-origin')).toBe('*');
		expect(pre.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
	});

	it('live WebSocket with ?key=, and tenancy checks', async () => {
		const a = await setup();
		const b = await setup();
		const pi = (await createIntent(a.keys.sk)).json;
		const live = await openLive(`/v1/public/payment_intents/${pi.id}/live?key=${a.keys.pk}`);
		expect((await live.next(1)).status).toBe('pending');
		live.ws.close();
		// Merchant B's publishable key can't see or watch A's intent; bad keys are refused.
		expect((await call('GET', `/v1/public/payment_intents/${pi.id}`, { key: b.keys.pk })).status).toBe(404);
		expect((await app.request(`/v1/public/payment_intents/${pi.id}/live?key=${b.keys.pk}`, { headers: { upgrade: 'websocket' } }, env)).status).toBe(404);
		expect((await app.request(`/v1/public/payment_intents/${pi.id}/live?key=${a.keys.sk}`, { headers: { upgrade: 'websocket' } }, env)).status).toBe(401);
		expect((await app.request(`/v1/public/payment_intents/${pi.id}/live`, { headers: { upgrade: 'websocket' } }, env)).status).toBe(401);
		// Test keys can't see live intents and vice versa.
		expect((await call('GET', `/v1/public/payment_intents/${pi.id}`, { key: a.keys.pkLive })).status).toBe(404);
	});
});

describe('intent responses', () => {
	it('include upi.qr_svg on create and retrieve, not in lists', async () => {
		const { keys } = await setup();
		const pi = (await createIntent(keys.sk)).json;
		expect(pi.upi.qr_svg).toContain('<svg');
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, { key: keys.sk })).json.upi.qr_svg).toContain('<svg');
		expect((await call('GET', '/v1/payment_intents', { key: keys.sk })).json.data[0].upi.qr_svg).toBeUndefined();
	});
});
