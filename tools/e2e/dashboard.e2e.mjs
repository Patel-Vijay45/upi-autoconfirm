#!/usr/bin/env node
// Browser end-to-end test of the merchant dashboard against a running API and dashboard.
//
//   cd apps/api && npx wrangler dev                                  (API on :8787, local D1 migrated)
//   cd apps/dashboard && API_URL=http://127.0.0.1:8787 npx vite dev   (dashboard on :5173)
//   node tools/e2e/dashboard.e2e.mjs     (E2E_API, E2E_DASH, E2E_ADMIN_TOKEN, E2E_SHOTS optional)
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const API = process.env.E2E_API ?? 'http://127.0.0.1:8787';
const DASH = process.env.E2E_DASH ?? 'http://127.0.0.1:5173';
const ADMIN = process.env.E2E_ADMIN_TOKEN ?? 'local-admin-token-0123456789abcdef0123';
const SHOTS = process.env.E2E_SHOTS ?? '';
const PASSWORD = 'counter staff secret 1';

let failures = 0;
const ok = (cond, what) => {
	console.log(`${cond ? '✓' : '✗'} ${what}`);
	if (!cond) failures++;
};
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function totp(secretB32, offsetSteps = 0) {
	const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const bytes = [];
	for (const ch of secretB32) {
		value = (value << 5) | A.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	const step = Math.floor(Date.now() / 30000) + offsetSteps;
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(step));
	const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
	const off = h[h.length - 1] & 15;
	return String((h.readUInt32BE(off) & 0x7fffffff) % 1e6).padStart(6, '0');
}

async function api(method, path, { key, body } = {}) {
	const res = await fetch(API + path, {
		method,
		headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
	return text ? JSON.parse(text) : null;
}

async function signal(device, amountPaise) {
	const body = JSON.stringify({ signals: [{ app: 'phonepe_business', amount_paise: amountPaise, payer_short: 'Ramesh P', posted_at: Date.now(), notification_key_hash: sha256(randomBytes(8).toString('hex')).slice(0, 32) }] });
	const ts = String(Math.floor(Date.now() / 1000));
	const nonce = 'n_' + randomBytes(12).toString('hex');
	const sig = createHmac('sha256', device.device_secret).update(['POST', '/device/v1/signals', ts, nonce, sha256(body)].join('\n')).digest('hex');
	const res = await fetch(`${API}/device/v1/signals`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': device.device_id, 'x-timestamp': ts, 'x-nonce': nonce, 'x-signature': sig }, body });
	return (await res.json()).results[0];
}

async function unpair(device) {
	const ts = String(Math.floor(Date.now() / 1000));
	const nonce = 'n_' + randomBytes(12).toString('hex');
	const sig = createHmac('sha256', device.device_secret).update(['POST', '/device/v1/unpair', ts, nonce, sha256('{}')].join('\n')).digest('hex');
	const res = await fetch(`${API}/device/v1/unpair`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': device.device_id, 'x-timestamp': ts, 'x-nonce': nonce, 'x-signature': sig }, body: '{}' });
	return res.status;
}

async function main() {
	const n = Date.now().toString(36);
	const ownerEmail = `owner-${n}@shop.example`;

	const browser = await chromium.launch();
	const errors = [];
	const watch = (p) => {
		p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
		p.on('console', (msg) => msg.type() === 'error' && !/Failed to load resource: the server responded with a status of 4\d\d/.test(msg.text()) && errors.push(`console: ${msg.text()}`));
	};
	const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
	const p = await ctx.newPage();
	watch(p);

	// ----- owner setup: password + authenticator -----
	// ----- operator page: create the shop and get the owner's setup link -----
	await p.goto(`${DASH}/operator`);
	const createForm = p.locator('form[action="?/createShop"]');
	await createForm.locator('input[name=token]').fill('wrong-operator-token');
	await createForm.locator('input[name=name]').fill('Sharma General Store');
	await createForm.locator('input[name=email]').fill(ownerEmail);
	await createForm.getByRole('button', { name: 'Create shop' }).click();
	await p.getByText('Wrong operator token.').waitFor();
	ok(true, 'operator: wrong token refused');
	await createForm.locator('input[name=token]').fill(ADMIN);
	await createForm.getByRole('button', { name: 'Create shop' }).click();
	await p.getByTestId('setup-url').waitFor();
	const setupUrl = (await p.getByTestId('setup-url').textContent()).trim();
	const sk = (await p.getByTestId('sk-test').textContent()).trim();
	ok(setupUrl.startsWith(`${DASH}/setup/inv_`) && sk.startsWith('sk_test_'), 'operator: shop created, setup link + keys shown');
	ok(!(await p.content()).includes(ADMIN), 'operator: token not echoed back');
	if (SHOTS) await p.screenshot({ path: `${SHOTS}/d0-operator.png`, fullPage: true });

	const res = await p.goto(setupUrl);
	ok(/script-src/.test(res.headers()['content-security-policy'] ?? ''), 'pages send a Content-Security-Policy');
	ok(await p.getByText('Sharma General Store').isVisible(), 'setup: shows the shop');
	ok(await p.locator('.qr svg').isVisible(), 'setup: authenticator QR shown');
	const secret = (await p.getByTestId('totp-secret').textContent()).trim();
	await p.fill('input[name=password]', PASSWORD);
	await p.fill('input[name=confirm]', PASSWORD);
	await p.fill('input[name=otp]', totp(secret));
	await p.click('button:has-text("Create my account")');
	await p.waitForURL(`${DASH}/`);
	ok(await p.getByRole('heading', { name: 'Payments' }).isVisible(), 'setup: lands on Payments');
	const cookie = (await ctx.cookies()).find((c) => c.name === 'ac_session');
	ok(cookie && cookie.httpOnly && cookie.sameSite === 'Lax', 'session cookie is HttpOnly + SameSite=Lax');

	// ----- switch to test data -----
	await p.click('button:has-text("Live data")');
	await p.getByText('Test mode: you are seeing test payments').waitFor();
	ok(true, 'mode: switched to test data');

	// ----- add a counter and pair a phone -----
	await p.goto(`${DASH}/locations`);
	await p.fill('input[name=name]', 'Counter 1');
	await p.fill('input[name=upi_vpa]', 'sharmastore@ybl');
	await p.fill('input[name=upi_payee_name]', 'Sharma General Store');
	await p.click('button:has-text("Add counter")');
	await p.getByText('Counter added').waitFor();
	ok(await p.getByText('sharmastore@ybl').isVisible(), 'locations: counter added');
	await p.click('a:has-text("Add phone")');
	await p.click('button:has-text("Create pairing code")');
	await p.getByTestId('pairing-qr').waitFor();
	const link = (await p.getByTestId('pairing-link').textContent()).trim();
	ok(link.startsWith('autoconfirm://pair?api=') && !decodeURIComponent(link).includes('.internal'), 'pairing: QR + link with a public API address');
	if (SHOTS) await p.screenshot({ path: `${SHOTS}/d1-pairing.png` });
	const code = new URL(link.replace('autoconfirm://', 'https://x/')).searchParams.get('code');
	const device = await api('POST', '/device/v1/enroll', { body: { pairing_code: code, device_info: { label: 'Counter phone' } } });
	await p.goto(`${DASH}/locations`);
	ok((await p.getByTestId('phone').count()) === 1, 'locations: paired phone listed');

	// ----- counter: "New payment" in the dashboard, QR, turns Paid by itself -----
	await p.goto(`${DASH}/`);
	await p.click('summary:has-text("New payment")');
	await p.fill('input[name=amount]', '1');
	await p.fill('input[name=note]', 'Counter test');
	await p.click('button:has-text("Create and show QR")');
	await p.getByTestId('pay-qr').waitFor();
	ok(await p.getByTestId('pay-qr').locator('svg').isVisible(), 'counter: new payment shows a QR');
	const shown = (await p.getByTestId('pay-qr').locator('.amount').textContent()).trim();
	const [rs, ps] = shown.replace(/[₹,]/g, '').split('.');
	const counterPaise = Number(rs) * 100 + Number(ps);
	ok(counterPaise > 100 && counterPaise < 200, `counter: unique amount ${shown}`);
	await signal(device, counterPaise);
	await p.getByTestId('paid-banner').waitFor({ timeout: 15000 });
	ok(true, 'counter: page turned Paid by itself after the phone signal');

	// ----- payments: one auto-confirmed, one via the inbox -----
	const auto = await api('POST', '/v1/payment_intents', { key: sk, body: { amount: 45000, order_id: 'ORD-501' } });
	await signal(device, auto.unique_amount);
	const manual = await api('POST', '/v1/payment_intents', { key: sk, body: { amount: 93000, order_id: 'ORD-502' } });
	await signal(device, 93000); // customer paid the round amount
	await p.goto(`${DASH}/`);
	ok(await p.locator('a.item', { hasText: 'ORD-501' }).getByText('Paid').isVisible(), 'payments: ORD-501 paid automatically');
	ok(await p.locator('a.item', { hasText: 'ORD-502' }).getByText('Waiting').isVisible(), 'payments: ORD-502 waiting');
	if (SHOTS) await p.screenshot({ path: `${SHOTS}/d2-payments.png` });

	await p.goto(`${DASH}/inbox`);
	const card = p.getByTestId('signal').first();
	ok(await card.getByText('₹930.00').isVisible(), 'inbox: unmatched ₹930.00 shown');
	ok(await card.getByText('ORD-502').isVisible(), 'inbox: suggests ORD-502');
	if (SHOTS) await p.screenshot({ path: `${SHOTS}/d3-inbox.png` });
	await card.locator('form', { hasText: 'ORD-502' }).getByRole('button', { name: 'Match' }).click();
	await p.getByText('Payment matched to the order.').waitFor();
	ok(await p.getByText('Nothing to check').isVisible(), 'inbox: empty after matching');
	await p.goto(`${DASH}/payments/${manual.id}`);
	ok(await p.getByTestId('paid-banner').getByText('Marked paid by staff').isVisible(), 'detail: ORD-502 paid (manual)');
	ok(await p.getByText('received ₹930.00').isVisible(), 'detail: shows amount mismatch');

	// ----- reports + CSV -----
	await p.goto(`${DASH}/reports`);
	const total = (await p.getByTestId('total-received').textContent()).trim();
	const expected = auto.unique_amount + 93000 + counterPaise;
	ok(total === `₹${Math.floor(expected / 100).toLocaleString('en-IN')}.${String(expected % 100).padStart(2, '0')}`, `reports: received total ${total}`);
	const csv = await p.request.get(`${DASH}/reports/payments.csv`);
	const csvText = await csv.text();
	ok(csv.headers()['content-type'].includes('text/csv') && csvText.includes('ORD-501') && csvText.includes('ORD-502'), 'reports: CSV download');

	// ----- developers: key shown once -----
	await p.goto(`${DASH}/developers`);
	await p.click('button:has-text("Create key")');
	const key = (await p.getByTestId('new-key').textContent()).trim();
	ok(/^sk_test_/.test(key), 'developers: new key shown once');
	const check = await fetch(`${API}/v1/locations`, { headers: { authorization: `Bearer ${key}` } });
	ok(check.status === 200, 'developers: the new key works');
	await p.goto(`${DASH}/developers`);
	ok((await p.getByTestId('new-key').count()) === 0 && !(await p.content()).includes(key), 'developers: key not shown again');

	// ----- locations: a phone that unpairs itself shows "Removed" without a reload -----
	await p.goto(`${DASH}/locations`);
	await p.click('a:has-text("Add phone")');
	await p.click('button:has-text("Create pairing code")');
	const link2 = (await p.getByTestId('pairing-link').textContent()).trim();
	const code2 = new URL(link2.replace('autoconfirm://', 'https://x/')).searchParams.get('code');
	const spare = await api('POST', '/device/v1/enroll', { body: { pairing_code: code2, device_info: { label: 'Spare phone' } } });
	await p.goto(`${DASH}/locations`);
	ok((await unpair(spare)) === 200, 'phone: unpairs itself');
	await p.locator('[data-testid=phone]', { hasText: 'Spare phone' }).getByText('Removed').waitFor({ timeout: 25000 });
	ok(true, 'locations: unpaired phone shows Removed by itself');

	// ----- settings: limit + invite staff -----
	await p.goto(`${DASH}/settings`);
	await p.fill('input[name=auto_confirm_max]', '2000');
	await p.click('button:has-text("Save")');
	await p.getByText('Settings saved.').waitFor();
	const limit = await p.inputValue('input[name=auto_confirm_max]');
	ok(limit === '2000.00', `settings: auto-confirm limit saved (${limit})`);
	const staffEmail = `staff-${n}@shop.example`;
	await p.fill('input[name=email]', staffEmail);
	await p.click('button:has-text("Invite")');
	const inviteUrl = (await p.getByTestId('invite-url').textContent()).trim();
	ok(inviteUrl.startsWith(`${DASH}/setup/inv_`), 'settings: staff invite link');
	if (SHOTS) await p.screenshot({ path: `${SHOTS}/d4-settings.png`, fullPage: true });

	// ----- staff: set up without an authenticator; limited menu -----
	const sctx = await browser.newContext({ ...devices['Pixel 7'] });
	const sp = await sctx.newPage();
	watch(sp);
	await sp.goto(inviteUrl);
	await sp.fill('input[name=password]', PASSWORD);
	await sp.fill('input[name=confirm]', PASSWORD);
	await sp.click('button:has-text("Create my account")');
	await sp.waitForURL(`${DASH}/`);
	const navText = await sp.locator('nav[aria-label=Main]').textContent();
	ok(navText.includes('Inbox') && !navText.includes('Settings') && !navText.includes('Developers'), 'staff: menu without Settings/Developers');
	const forbidden = await sp.goto(`${DASH}/settings`);
	ok(forbidden.status() === 403, 'staff: settings page refused (403)');
	await sp.goto(`${DASH}/`);
	if (SHOTS) await sp.screenshot({ path: `${SHOTS}/d5-staff-phone.png` });
	await sctx.close();

	// ----- logout and log back in with a fresh code -----
	await p.goto(`${DASH}/`);
	await p.click('button:has-text("Log out")');
	await p.waitForURL(`${DASH}/login`);
	await p.goto(`${DASH}/`);
	ok(p.url() === `${DASH}/login`, 'logged out: pages redirect to login');
	await p.fill('input[name=email]', ownerEmail);
	await p.fill('input[name=password]', 'wrong password');
	await p.click('button:has-text("Log in")');
	await p.locator('.error').waitFor({ timeout: 10000 });
	const loginErr = (await p.locator('.error').textContent()).trim();
	ok(loginErr === 'wrong email or password', `login: wrong password refused (${loginErr})`);
	await p.fill('input[name=password]', PASSWORD);
	await p.fill('input[name=otp]', totp(secret, 1));
	await p.click('button:has-text("Log in")');
	await p.waitForURL(`${DASH}/`);
	ok(await p.getByRole('heading', { name: 'Payments' }).isVisible(), 'login: owner back in with password + code');

	await browser.close();
	ok(errors.length === 0, `no browser errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
	console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
