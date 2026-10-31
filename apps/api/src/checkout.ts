// Customer-facing checkout: the hosted page (/p/:id), the checkout.js widget and live status.
//
// Hosted-page routes are reached by the intent id alone. Ids carry 100 random bits, and these routes only
// return what the customer needs to pay (amount, payee name, UPI links, status). No customer data.
import type { Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { CHECKOUT_CSS, esc, renderCheckout } from '@autoconfirm/checkout/template';
import { fill, pickLang, STRINGS } from '@autoconfirm/checkout/i18n';
import type { Env } from './env.ts';
import { authKey, authKeyValue } from './auth.ts';
import { notFound } from './errors.ts';
import { getIntent, getLocation, getMerchant, type IntentRow, type LocationRow } from './db.ts';
import { checkoutView, presentPublicStatus } from './present.ts';
import { locationObjectName } from './location-do.ts';
import { settingsFromJson } from './settings.ts';
import { PAGE_JS, WIDGET_JS } from './generated/checkout-assets.ts';

const ID = /^pi_[a-z2-7]{20}$/;

type AnyEnv = { Bindings: Env; Variables: any };

async function loadById(env: Env, id: string): Promise<{ row: IntentRow; loc: LocationRow } | null> {
	if (!ID.test(id)) return null;
	// The only lookup without merchant_id: the unguessable id is the credential for the hosted page.
	const row = await env.DB.prepare('SELECT * FROM payment_intents WHERE id = ?').bind(id).first<IntentRow>();
	if (!row) return null;
	const merchant = await getMerchant(env.DB, row.merchant_id);
	if (!merchant || merchant.status !== 'active') return null;
	const loc = await getLocation(env.DB, row.merchant_id, row.location_id);
	return loc ? { row, loc } : null;
}

function stubFor(env: Env, row: IntentRow) {
	return env.LOCATION.get(env.LOCATION.idFromName(locationObjectName(row.merchant_id, row.location_id, row.livemode === 1)));
}

/** Forward a WebSocket upgrade to the intent's location object, with a status snapshot as fallback. */
function forwardLive(c: Context<AnyEnv>, row: IntentRow) {
	if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: { type: 'invalid_request', code: 'websocket_required', message: 'expected a WebSocket upgrade' } }, 426);
	const status = presentPublicStatus(row, Date.now());
	return stubFor(c.env, row).fetch('https://location.internal/live', {
		headers: { upgrade: 'websocket', 'x-intent-id': row.id, 'x-intent-status': status.status, 'x-paid-at': status.paid_at ?? '', 'x-expires-at': status.expires_at ?? '' },
	});
}

async function claim(env: Env, row: IntentRow) {
	const merchant = await getMerchant(env.DB, row.merchant_id);
	const settings = settingsFromJson(merchant?.settings);
	const r = await stubFor(env, row).claim({ merchantId: row.merchant_id, locationId: row.location_id, livemode: row.livemode === 1, settings }, row.id);
	return r.ok ? { ...row, customer_claimed_at: r.value.customerClaimedAt } : row;
}

function nonce(): string {
	const b = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...b));
}

const PAGE_CSS = 'html,body{margin:0;background:#fff}body{padding:.5rem 0 2rem}@media (prefers-color-scheme:dark){html,body{background:#121212}}';

function pageHeaders(n: string, wsOrigin: string): Record<string, string> {
	return {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
		'content-security-policy': `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; img-src data:; connect-src 'self' ${wsOrigin}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
		'referrer-policy': 'no-referrer',
	};
}

function notFoundPage(c: Context<AnyEnv>) {
	const n = nonce();
	const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Payment link not found</title><style nonce="${n}">${PAGE_CSS}${CHECKOUT_CSS}</style></head><body><div class="ac"><div class="ac-msg">This payment link is not valid. Please ask the shop for a new one.</div></div></body></html>`;
	return c.body(body, 404, pageHeaders(n, ''));
}

export function registerCheckout(app: Hono<AnyEnv>) {
	// Browser calls from merchants' sites use the publishable key; no cookies, so any origin is fine.
	app.use('/v1/public/*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 86400 }));

	// ----- hosted checkout page -----

	app.get('/p/:id', async (c) => {
		const found = await loadById(c.env, c.req.param('id'));
		if (!found) return notFoundPage(c);
		const lang = pickLang(c.req.query('lang') ?? c.req.header('accept-language'));
		const t = STRINGS[lang];
		const view = checkoutView(found.row, found.loc, Date.now());
		const origin = new URL(c.req.url).origin;
		const wsOrigin = origin.replace(/^http/, 'ws');
		const id = view.id;
		const config = JSON.stringify({ view, lang, statusUrl: `/p/${id}/status`, liveUrl: `${wsOrigin}/p/${id}/live`, claimUrl: `/p/${id}/claim` }).replace(/</g, '\\u003c');
		const n = nonce();
		const title = `${fill(t.payTo, { payee: view.payee_name })} ₹${view.display_amount}`;
		const html =
			`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
			`<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title>` +
			`<style nonce="${n}">${PAGE_CSS}${CHECKOUT_CSS}</style></head><body>` +
			renderCheckout(view, lang) +
			`<script type="application/json" id="ac-config">${config}</script>` +
			`<script nonce="${n}">${PAGE_JS}</script></body></html>`;
		return c.body(html, 200, pageHeaders(n, wsOrigin));
	});

	app.get('/p/:id/status', async (c) => {
		const found = await loadById(c.env, c.req.param('id'));
		if (!found) throw notFound('payment intent');
		c.header('cache-control', 'no-store');
		return c.json(presentPublicStatus(found.row, Date.now()));
	});

	app.post('/p/:id/claim', async (c) => {
		const found = await loadById(c.env, c.req.param('id'));
		if (!found) throw notFound('payment intent');
		return c.json(presentPublicStatus(await claim(c.env, found.row), Date.now()));
	});

	app.get('/p/:id/live', async (c) => {
		const found = await loadById(c.env, c.req.param('id'));
		if (!found) throw notFound('payment intent');
		return forwardLive(c, found.row);
	});

	// ----- checkout.js widget (publishable key) -----

	app.get('/v1/checkout.js', (c) =>
		c.body(WIDGET_JS, 200, {
			'content-type': 'application/javascript; charset=utf-8',
			'cache-control': 'public, max-age=300',
			'access-control-allow-origin': '*',
			'x-content-type-options': 'nosniff',
		}),
	);

	const loadPublic = async (c: Context<AnyEnv>, auth: Awaited<ReturnType<typeof authKey>>) => {
		const row = await getIntent(c.env.DB, auth.merchantId, c.req.param('id') ?? '');
		if (!row || (row.livemode === 1) !== auth.livemode) throw notFound('payment intent');
		const loc = await getLocation(c.env.DB, auth.merchantId, row.location_id);
		if (!loc) throw notFound('payment intent');
		return { row, loc };
	};

	app.get('/v1/public/payment_intents/:id', async (c) => {
		const { row, loc } = await loadPublic(c, await authKey(c, 'publishable'));
		c.header('cache-control', 'no-store');
		return c.json(checkoutView(row, loc, Date.now()));
	});

	// Browsers can't set headers on WebSockets, so the publishable key comes as ?key=.
	app.get('/v1/public/payment_intents/:id/live', async (c) => {
		const auth = await authKeyValue(c.env, `Bearer ${c.req.query('key') ?? ''}`, 'publishable');
		const { row } = await loadPublic(c, auth);
		return forwardLive(c, row);
	});
}

