#!/usr/bin/env node
// Browser end-to-end test of the hosted checkout page and checkout.js, against a running API (wrangler dev).
//
//   cd apps/api && npx wrangler dev        (with .dev.vars, local D1 migrated)
//   node tools/e2e/checkout.e2e.mjs        (E2E_API, E2E_ADMIN_TOKEN, E2E_SHOTS optional)
//
// Uses the Playwright library and its Chromium. Exits non-zero on any failure or browser console error.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const API = process.env.E2E_API ?? 'http://127.0.0.1:8787';
const ADMIN = process.env.E2E_ADMIN_TOKEN ?? 'local-admin-token-0123456789abcdef0123';
const SHOTS = process.env.E2E_SHOTS ?? '';
const SITE_PORT = 8899;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
let failures = 0;
const ok = (cond, what) => {
	console.log(`${cond ? '✓' : '✗'} ${what}`);
	if (!cond) failures++;
};

async function api(method, path, { key, body, headers = {} } = {}) {
	const res = await fetch(API + path, {
		method,
		headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
	return text ? JSON.parse(text) : null;
}

async function signal(device, amountPaise) {
	const body = JSON.stringify({
		signals: [{ app: 'phonepe_business', amount_paise: amountPaise, payer_short: 'Test P', posted_at: Date.now(), notification_key_hash: sha256(randomBytes(8).toString('hex')).slice(0, 32) }],
	});
	const ts = String(Math.floor(Date.now() / 1000));
	const nonce = 'n_' + randomBytes(12).toString('hex');
	const sig = createHmac('sha256', device.device_secret).update(['POST', '/device/v1/signals', ts, nonce, sha256(body)].join('\n')).digest('hex');
	const res = await fetch(`${API}/device/v1/signals`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-device-id': device.device_id, 'x-timestamp': ts, 'x-nonce': nonce, 'x-signature': sig },
		body,
	});
	return (await res.json()).results[0];
}

// A stand-in merchant website on another origin: a "done" page and a page that embeds checkout.js.
const site = createServer((req, res) => {
	const u = new URL(req.url, SITE);
	res.setHeader('content-type', 'text/html; charset=utf-8');
	if (u.pathname === '/done') return res.end('<!doctype html><title>Done</title><h1>Order complete</h1>');
	if (u.pathname === '/shop') {
		const { key, intent } = Object.fromEntries(u.searchParams);
		return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shop</title>
<script src="${API}/v1/checkout.js"></script>
<button id="pay">Pay</button>
<script>
  document.getElementById('pay').onclick = () => AutoConfirm.open({
    key: ${JSON.stringify(key)}, intent: ${JSON.stringify(intent)}, lang: 'en',
    onPaid: (pi) => { window.__paid = pi; }, onClose: () => { window.__closed = true; }
  });
</script>`);
	}
	res.statusCode = 404;
	res.end('not found');
});

async function main() {
	await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r));
	const m = await api('POST', '/admin/v1/merchants', { key: ADMIN, body: { name: 'E2E checkout' } });
	const sk = m.secret_key_test;
	const pk = m.publishable_key_test;
	const loc = await api('POST', '/v1/locations', { key: sk, body: { name: 'Counter 1', upi_vpa: 'shop@ybl', upi_payee_name: 'My Shop' } });
	const pc = await api('POST', `/v1/locations/${loc.id}/pairing_codes`, { key: sk });
	const device = await api('POST', '/device/v1/enroll', { body: { pairing_code: pc.code } });
	const newIntent = (extra = {}) =>
		api('POST', '/v1/payment_intents', { key: sk, body: { amount: 93000, order_id: 'ORD-1042', return_url: `${SITE}/done`, ...extra } });

	const browser = await chromium.launch();
	const errors = [];
	const watch = (p) => {
		p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
		p.on('console', (msg) => msg.type() === 'error' && errors.push(`console: ${msg.text()}`));
	};

	// ----- 1. Hosted page on a phone: pay, live update, redirect -----
	{
		const pi = await newIntent();
		const ctx = await browser.newContext({ ...devices['Pixel 7'] });
		const p = await ctx.newPage();
		watch(p);
		await p.goto(`${API}/p/${pi.id}`);
		ok((await p.locator('.ac-amount').textContent()) === `₹${pi.display_amount}`, `phone: shows ₹${pi.display_amount}`);
		ok(await p.getByText('Pay with Google Pay').isVisible(), 'phone: app buttons visible');
		ok((await p.getByText('Pay with Google Pay').getAttribute('href')) === pi.upi.apps.gpay, 'phone: Google Pay link is the intent link');
		ok((await p.getByText('Other UPI app').getAttribute('href')) === pi.upi.uri, 'phone: generic upi:// link');
		ok(/Expires in 1[45]:\d\d/.test((await p.locator('[data-ac-timer]').textContent()) ?? ''), 'phone: countdown running');
		if (SHOTS) await p.screenshot({ path: `${SHOTS}/1-phone-pending.png` });
		await p.getByText('I have paid').click();
		await p.getByText('Checking payment').waitFor({ timeout: 5000 });
		ok(true, 'phone: "I have paid" shows checking');
		const t0 = Date.now();
		const r = await signal(device, pi.unique_amount);
		ok(r.status === 'matched', 'phone: signal matched');
		await p.getByText('Payment received ✓').waitFor({ timeout: 5000 });
		const ms = Date.now() - t0;
		ok(ms < 3000, `phone: page shows paid ${ms} ms after the signal (target < 3 s)`);
		if (SHOTS) await p.screenshot({ path: `${SHOTS}/2-phone-paid.png` });
		await p.waitForURL(`${SITE}/done`, { timeout: 5000 });
		ok(true, 'phone: redirected to return_url');
		await ctx.close();
	}

	// ----- 2. Hosted page on a desktop: QR first, app buttons hidden -----
	{
		const pi = await newIntent({ amount: 50000 });
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const p = await ctx.newPage();
		watch(p);
		await p.goto(`${API}/p/${pi.id}?lang=hi`);
		ok(await p.locator('.ac-qr svg').isVisible(), 'desktop: QR visible');
		const qrY = (await p.locator('.ac-qr').boundingBox()).y;
		const appsY = (await p.locator('.ac-apps').boundingBox()).y;
		ok(qrY < appsY, 'desktop: QR shown before the app buttons');
		ok(await p.getByText('मैंने भुगतान कर दिया').isVisible(), 'desktop: Hindi text');
		if (SHOTS) await p.screenshot({ path: `${SHOTS}/3-desktop-hindi.png` });
		await api('POST', `/v1/payment_intents/${pi.id}/cancel`, { key: sk });
		await p.waitForFunction(() => document.querySelector('[data-ac-root]')?.getAttribute('data-status') === 'cancelled', null, { timeout: 5000 });
		ok(true, 'desktop: cancel shows live');
		await ctx.close();
	}

	// ----- 3. checkout.js widget on a merchant site (another origin) -----
	{
		const pi = await newIntent({ amount: 12300, order_id: 'ORD-WIDGET' });
		const ctx = await browser.newContext({ ...devices['Pixel 7'] });
		const p = await ctx.newPage();
		watch(p);
		await p.goto(`${SITE}/shop?key=${pk}&intent=${pi.id}`);
		await p.click('#pay');
		const sheet = p.locator('div[role=dialog]'); // pierces the shadow root
		await sheet.getByText(`₹${pi.display_amount}`).waitFor({ timeout: 5000 });
		ok(true, 'widget: opens with the amount');
		ok((await sheet.getByText('Pay with PhonePe').getAttribute('href')) === pi.upi.apps.phonepe, 'widget: PhonePe link');
		if (SHOTS) await p.screenshot({ path: `${SHOTS}/4-widget.png` });
		await signal(device, pi.unique_amount);
		await p.waitForFunction(() => window.__paid, null, { timeout: 5000 });
		const paid = await p.evaluate(() => window.__paid);
		ok(paid.status === 'paid' && paid.order_id === 'ORD-WIDGET' && paid.id === pi.id, 'widget: onPaid called with the intent');
		await sheet.getByText('Payment received ✓').waitFor({ timeout: 5000 });
		await p.keyboard.press('Escape');
		ok(await p.evaluate(() => window.__closed === true), 'widget: Escape closes it');
		await ctx.close();
	}

	await browser.close();
	site.close();
	ok(errors.length === 0, `no browser errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
	console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	site.close();
	process.exit(1);
});
