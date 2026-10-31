// HTTP API (Hono). Contracts: api/openapi.yaml and docs/API.md.
// Tenancy: every D1 query filters by merchant_id (and livemode); location objects are keyed by tenant.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { encryptSecret, randomId, randomSecret, sha256Hex, timingSafeEqual, type Intent } from '@autoconfirm/core';
import type { Env } from './env.ts';
import { ApiError, fromEngine, notFound, unauthorized } from './errors.ts';
import { authDevice, authKey, readBody, type MerchantAuth } from './auth.ts';
import {
	getIntent,
	getLocation,
	getMerchant,
	getSignal,
	listLocations,
	type IntentRow,
	type LocationRow,
	type NewIntentExtras,
	type SignalRow,
} from './db.ts';
import { iso, presentIntent, presentPublicStatus, presentSignal, rowFromEngine } from './present.ts';
import { locationObjectName, type Actor, type LocationCtx, type Result } from './location-do.ts';
import { settingsFromJson } from './settings.ts';

type AppEnv = { Bindings: Env; Variables: { auth: MerchantAuth } };
type Ctx = Context<AppEnv>;

export const EVENT_TYPES = [
	'payment_intent.paid',
	'payment_intent.expired',
	'payment_intent.cancelled',
	'payment_intent.unpaid',
	'signal.unmatched',
	'signal.review_required',
	'device.offline',
	'device.online',
	'device.parse_failed',
] as const;

// ---------- helpers ----------

function parseJson<T extends z.ZodType>(raw: string, schema: T): z.infer<T> {
	let data: unknown;
	try {
		data = raw.trim() === '' ? {} : JSON.parse(raw);
	} catch {
		throw new ApiError(400, 'invalid_request', 'invalid_json', 'body is not valid JSON');
	}
	const r = schema.safeParse(data);
	if (!r.success) {
		const issue = r.error.issues[0];
		const param = issue?.path.join('.') || undefined;
		throw new ApiError(400, 'invalid_request', 'invalid_param', issue?.message ?? 'invalid request', param);
	}
	return r.data;
}

function unwrap<T>(r: Result<T>): T {
	if (!r.ok) throw fromEngine(r.code, r.message);
	return r.value;
}

function locationStub(env: Env, merchantId: string, locationId: string, livemode: boolean) {
	return env.LOCATION.get(env.LOCATION.idFromName(locationObjectName(merchantId, locationId, livemode)));
}

function lctx(auth: Pick<MerchantAuth, 'merchantId' | 'livemode' | 'settings'>, locationId: string): LocationCtx {
	return { merchantId: auth.merchantId, locationId, livemode: auth.livemode, settings: auth.settings };
}

function actor(c: Ctx): Actor {
	return { by: `key:${c.get('auth').keyPrefix}`, ip: c.req.header('cf-connecting-ip') ?? null };
}

/** Apply the engine's latest view on top of a D1 row (D1 is written by the outbox and may briefly lag). */
function overlay(row: IntentRow, i: Intent): IntentRow {
	return {
		...row,
		status: i.status,
		customer_claimed_at: i.customerClaimedAt,
		paid_at: i.paidAt,
		paid_source: i.paidSource,
		paid_by_user: i.paidBy,
		matched_signal_id: i.matchedSignalId,
		late: i.late ? 1 : 0,
		amount_mismatch: i.amountMismatch ? 1 : 0,
		cancelled_at: i.cancelledAt,
		reserved_until: i.reservedUntil,
		updated_at: i.updatedAt,
	};
}

async function loadIntent(c: Ctx, id: string): Promise<IntentRow> {
	const auth = c.get('auth');
	const row = await getIntent(c.env.DB, auth.merchantId, id);
	if (!row || (row.livemode === 1) !== auth.livemode) throw notFound('payment intent');
	return row;
}

async function loadSignal(c: Ctx, id: string): Promise<SignalRow> {
	const auth = c.get('auth');
	const row = await getSignal(c.env.DB, auth.merchantId, id);
	if (!row || (row.livemode === 1) !== auth.livemode) throw notFound('signal');
	return row;
}

async function loadLocation(c: Ctx, id: string): Promise<LocationRow> {
	const loc = await getLocation(c.env.DB, c.get('auth').merchantId, id);
	if (!loc) throw notFound('location');
	return loc;
}

async function intentResponse(c: Ctx, row: IntentRow) {
	const loc = await loadLocation(c, row.location_id);
	const matched = row.matched_signal_id ? await getSignal(c.env.DB, row.merchant_id, row.matched_signal_id) : null;
	return presentIntent(row, loc, c.env.CHECKOUT_BASE_URL, Date.now(), matched);
}

/** "Ramesh Patel" -> "Ramesh P". Data minimisation is also enforced on the device. */
export function shortPayer(name: string | null | undefined): string | null {
	if (!name) return null;
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return null;
	const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
	const first = cap(words[0]!.slice(0, 20));
	const initial = words[1]?.charAt(0).toUpperCase();
	return initial ? `${first} ${initial}` : first;
}

async function makeKey(db: D1Database, merchantId: string, kind: 'secret' | 'publishable', livemode: boolean, now: number) {
	const key = `${kind === 'secret' ? 'sk' : 'pk'}_${livemode ? 'live' : 'test'}_${randomSecret()}`;
	await db
		.prepare('INSERT INTO api_keys (id, merchant_id, kind, livemode, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.bind(randomId('key'), merchantId, kind, livemode ? 1 : 0, key.slice(0, 12), await sha256Hex(key), now)
		.run();
	return key;
}

// ---------- schemas ----------

const IdemKey = z.string().min(1).max(64).regex(/^[\x21-\x7e]+$/);

const CreateIntent = z
	.object({
		amount: z.number().int().min(100).max(10_000_000),
		location_id: z.string().max(64).optional(),
		order_id: z.string().max(64).optional(),
		description: z.string().max(140).optional(),
		customer: z.object({ name: z.string().max(80).optional(), phone: z.string().max(20).optional() }).strict().optional(),
		expires_in: z.number().int().min(120).max(3 * 3600).optional(),
		return_url: z.url({ protocol: /^https?$/ }).max(500).optional(),
		metadata: z
			.record(z.string().max(40), z.string().max(500))
			.refine((m) => Object.keys(m).length <= 20, 'at most 20 metadata keys')
			.optional(),
	})
	.strict();

const ListQuery = z.object({
	status: z.enum(['pending', 'paid', 'expired', 'cancelled']).optional(),
	location_id: z.string().max(64).optional(),
	created_after: z.iso.datetime().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	starting_after: z.string().max(64).optional(),
});

const SignalListQuery = z.object({
	status: z.enum(['matched', 'unmatched', 'ambiguous', 'review', 'ignored', 'duplicate']).optional(),
	location_id: z.string().max(64).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	starting_after: z.string().max(64).optional(),
});

const Note = z.object({ note: z.string().max(200).optional(), signal_id: z.string().max(64).optional() }).strict();
const Reason = z.object({ reason: z.string().max(200).optional() }).strict();
const Unmark = z.object({ reason: z.string().min(1).max(200), status: z.enum(['pending', 'cancelled']).default('pending') }).strict();
const Assign = z.object({ payment_intent: z.string().max(64) }).strict();

const CreateLocation = z
	.object({
		name: z.string().min(1).max(80),
		upi_vpa: z.string().regex(/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/, 'not a valid UPI ID'),
		upi_payee_name: z.string().min(1).max(60),
	})
	.strict();

const CreateEndpoint = z
	.object({
		url: z.url({ protocol: /^https$/ }).max(500),
		events: z.array(z.enum([...EVENT_TYPES, '*'])).min(1).max(EVENT_TYPES.length + 1),
	})
	.strict();

const Enroll = z
	.object({
		pairing_code: z.string().min(8).max(64),
		device_info: z
			.object({
				label: z.string().max(60).optional(),
				model: z.string().max(60).optional(),
				android_version: z.string().max(20).optional(),
				app_version: z.string().max(20).optional(),
			})
			.strict()
			.default({}),
	})
	.strict();

const SignalBatch = z
	.object({
		signals: z
			.array(
				z
					.object({
						app: z.string().regex(/^[a-z0-9_]{2,40}$/),
						amount_paise: z.number().int().min(1).max(100_000_000),
						payer_short: z.string().max(60).nullish(),
						reference: z.string().max(64).nullish(),
						posted_at: z.number().int().min(0),
						notification_key_hash: z.string().regex(/^[0-9a-f]{16,64}$/),
						rules_version: z.string().max(40).optional(),
					})
					.strict(),
			)
			.min(1)
			.max(50),
	})
	.strict();

const Heartbeat = z
	.object({
		device_time: z.number().int().min(0),
		listener_connected: z.boolean(),
		app_version: z.string().max(20).optional(),
		queue_size: z.number().int().min(0).optional(),
		battery_optimized: z.boolean().optional(),
	})
	.strict();

const CreateMerchant = z
	.object({
		name: z.string().min(1).max(100),
		settings: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
	})
	.strict();

// ---------- app ----------

export const app = new Hono<AppEnv>();

app.onError((err, c) => {
	if (err instanceof ApiError) {
		return c.json({ error: { type: err.type, code: err.code, message: err.message, ...(err.param ? { param: err.param } : {}) } }, err.status);
	}
	console.error('unhandled error', err instanceof Error ? err.name : 'unknown');
	return c.json({ error: { type: 'api_error', code: 'internal', message: 'internal error' } }, 500);
});

app.notFound((c) => c.json({ error: { type: 'not_found', code: 'not_found', message: 'route not found' } }, 404));

app.get('/', (c) => c.json({ service: 'upi-autoconfirm', ok: true }));

// Merchant (secret key) routes: everything under /v1 except /v1/public.
app.use('/v1/*', async (c, next) => {
	if (c.req.path.startsWith('/v1/public/')) return next();
	c.set('auth', await authKey(c, 'secret'));
	return next();
});

// ----- locations -----

app.post('/v1/locations', async (c) => {
	const auth = c.get('auth');
	const body = parseJson(await readBody(c), CreateLocation);
	const id = randomId('loc');
	const now = Date.now();
	await c.env.DB.prepare('INSERT INTO locations (id, merchant_id, name, upi_vpa, upi_payee_name, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
		.bind(id, auth.merchantId, body.name, body.upi_vpa, body.upi_payee_name, now)
		.run();
	return c.json({ id, object: 'location', name: body.name, upi_vpa: body.upi_vpa, upi_payee_name: body.upi_payee_name, active: true, created: iso(now) }, 201);
});

app.get('/v1/locations', async (c) => {
	const rows = await listLocations(c.env.DB, c.get('auth').merchantId);
	return c.json({
		data: rows.map((l) => ({ id: l.id, object: 'location', name: l.name, upi_vpa: l.upi_vpa, upi_payee_name: l.upi_payee_name, active: l.active === 1, created: iso(l.created_at) })),
	});
});

app.post('/v1/locations/:id/pairing_codes', async (c) => {
	const auth = c.get('auth');
	const loc = await loadLocation(c, c.req.param('id'));
	const code = `pc_${randomSecret(24)}`;
	const expiresAt = Date.now() + 10 * 60_000;
	await c.env.DB.prepare('INSERT INTO pairing_codes (code_hash, merchant_id, location_id, livemode, expires_at) VALUES (?, ?, ?, ?, ?)')
		.bind(await sha256Hex(code), auth.merchantId, loc.id, auth.livemode ? 1 : 0, expiresAt)
		.run();
	return c.json({ object: 'pairing_code', code, location_id: loc.id, livemode: auth.livemode, expires_at: iso(expiresAt) }, 201);
});

// ----- payment intents -----

app.post('/v1/payment_intents', async (c) => {
	const auth = c.get('auth');
	const raw = await readBody(c);
	const body = parseJson(raw, CreateIntent);
	const keyHeader = c.req.header('idempotency-key');
	const idemKey = keyHeader === undefined ? null : IdemKey.safeParse(keyHeader).success ? keyHeader : null;
	if (keyHeader !== undefined && idemKey === null) throw new ApiError(400, 'invalid_request', 'invalid_idempotency_key', 'Idempotency-Key must be 1-64 printable characters');
	const now = Date.now();
	const requestHash = await sha256Hex(`POST /v1/payment_intents\n${auth.livemode}\n${raw}`);

	if (idemKey) {
		const prev = await c.env.DB.prepare('SELECT request_hash, response FROM idempotency WHERE merchant_id = ? AND key = ? AND created_at > ?')
			.bind(auth.merchantId, idemKey, now - 24 * 3600_000)
			.first<{ request_hash: string; response: string }>();
		if (prev) {
			if (prev.request_hash !== requestHash) throw new ApiError(409, 'conflict', 'idempotency_mismatch', 'Idempotency-Key was used with a different request');
			return c.json(JSON.parse(prev.response) as object, 201);
		}
	}

	// Location: explicit, or the merchant's only active location.
	let loc: LocationRow;
	if (body.location_id) {
		loc = await loadLocation(c, body.location_id);
	} else {
		const active = (await listLocations(c.env.DB, auth.merchantId)).filter((l) => l.active === 1);
		if (active.length !== 1) throw new ApiError(400, 'invalid_request', 'location_required', 'location_id is required when the merchant has more than one location', 'location_id');
		loc = active[0]!;
	}
	if (loc.active !== 1) throw new ApiError(422, 'invalid_request', 'location_not_ready', 'location is not active', 'location_id');
	const device = await c.env.DB.prepare("SELECT id FROM devices WHERE merchant_id = ? AND location_id = ? AND livemode = ? AND status != 'revoked' LIMIT 1")
		.bind(auth.merchantId, loc.id, auth.livemode ? 1 : 0)
		.first();
	if (!device) throw new ApiError(422, 'invalid_request', 'location_not_ready', 'no phone is paired with this location', 'location_id');

	const extras: NewIntentExtras = {
		merchantId: auth.merchantId,
		locationId: loc.id,
		livemode: auth.livemode,
		description: body.description ?? null,
		customerName: body.customer?.name ?? null,
		customerPhone: body.customer?.phone ?? null,
		returnUrl: body.return_url ?? null,
		metadata: body.metadata ?? {},
		idempotencyKey: idemKey,
	};
	const id = randomId('pi');
	const r = unwrap(
		await locationStub(c.env, auth.merchantId, loc.id, auth.livemode).createIntent(lctx(auth, loc.id), {
			id,
			amount: body.amount,
			orderId: body.order_id ?? null,
			ttlMs: body.expires_in !== undefined ? body.expires_in * 1000 : undefined,
			extras,
		}),
	);

	let response;
	if (r.existingId) {
		const row = await getIntent(c.env.DB, auth.merchantId, r.existingId);
		if (!row) throw new ApiError(409, 'conflict', 'idempotency_in_progress', 'a request with this Idempotency-Key is still being processed');
		response = presentIntent(r.intent ? overlay(row, r.intent) : row, loc, c.env.CHECKOUT_BASE_URL, now);
	} else {
		response = presentIntent(rowFromEngine(r.intent!, extras), loc, c.env.CHECKOUT_BASE_URL, now);
	}
	if (idemKey) {
		await c.env.DB.prepare('INSERT OR IGNORE INTO idempotency (merchant_id, key, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?)')
			.bind(auth.merchantId, idemKey, requestHash, JSON.stringify(response), now)
			.run();
	}
	return c.json(response, 201);
});

app.get('/v1/payment_intents', async (c) => {
	const auth = c.get('auth');
	const q = ListQuery.safeParse(c.req.query());
	if (!q.success) throw new ApiError(400, 'invalid_request', 'invalid_param', q.error.issues[0]?.message ?? 'invalid query');
	const where = ['merchant_id = ?', 'livemode = ?'];
	const args: unknown[] = [auth.merchantId, auth.livemode ? 1 : 0];
	if (q.data.status) (where.push('status = ?'), args.push(q.data.status));
	if (q.data.location_id) (where.push('location_id = ?'), args.push(q.data.location_id));
	if (q.data.created_after) (where.push('created_at > ?'), args.push(Date.parse(q.data.created_after)));
	if (q.data.starting_after) {
		const cur = await getIntent(c.env.DB, auth.merchantId, q.data.starting_after);
		if (!cur) throw new ApiError(400, 'invalid_request', 'invalid_param', 'starting_after not found', 'starting_after');
		where.push('(created_at < ? OR (created_at = ? AND id < ?))');
		args.push(cur.created_at, cur.created_at, cur.id);
	}
	const rows = await c.env.DB.prepare(`SELECT * FROM payment_intents WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
		.bind(...args, q.data.limit + 1)
		.all<IntentRow>();
	const locs = new Map((await listLocations(c.env.DB, auth.merchantId)).map((l) => [l.id, l]));
	const now = Date.now();
	const page = rows.results.slice(0, q.data.limit);
	return c.json({
		object: 'list',
		data: page.flatMap((r) => {
			const l = locs.get(r.location_id);
			return l ? [presentIntent(r, l, c.env.CHECKOUT_BASE_URL, now)] : [];
		}),
		has_more: rows.results.length > q.data.limit,
	});
});

app.get('/v1/payment_intents/:id', async (c) => c.json(await intentResponse(c, await loadIntent(c, c.req.param('id')))));

app.post('/v1/payment_intents/:id/cancel', async (c) => {
	const auth = c.get('auth');
	const row = await loadIntent(c, c.req.param('id'));
	const i = unwrap(await locationStub(c.env, auth.merchantId, row.location_id, auth.livemode).cancel(lctx(auth, row.location_id), row.id, actor(c)));
	return c.json(await intentResponse(c, overlay(row, i)));
});

app.post('/v1/payment_intents/:id/mark_paid', async (c) => {
	const auth = c.get('auth');
	const body = parseJson(await readBody(c), Note);
	const row = await loadIntent(c, c.req.param('id'));
	if (body.signal_id) {
		const sig = await loadSignal(c, body.signal_id);
		if (sig.location_id !== row.location_id) throw new ApiError(400, 'invalid_request', 'location_mismatch', 'signal and intent are at different locations', 'signal_id');
	}
	const i = unwrap(
		await locationStub(c.env, auth.merchantId, row.location_id, auth.livemode).markPaid(lctx(auth, row.location_id), row.id, body.signal_id ?? null, actor(c), body.note ?? null),
	);
	return c.json(await intentResponse(c, overlay(row, i)));
});

app.post('/v1/payment_intents/:id/unmark_paid', async (c) => {
	const auth = c.get('auth');
	const body = parseJson(await readBody(c), Unmark);
	const row = await loadIntent(c, c.req.param('id'));
	const i = unwrap(
		await locationStub(c.env, auth.merchantId, row.location_id, auth.livemode).unmarkPaid(lctx(auth, row.location_id), row.id, body.status, actor(c), body.reason),
	);
	return c.json(await intentResponse(c, overlay(row, i)));
});

// ----- signals (inbox) -----

app.get('/v1/signals', async (c) => {
	const auth = c.get('auth');
	const q = SignalListQuery.safeParse(c.req.query());
	if (!q.success) throw new ApiError(400, 'invalid_request', 'invalid_param', q.error.issues[0]?.message ?? 'invalid query');
	const where = ['merchant_id = ?', 'livemode = ?'];
	const args: unknown[] = [auth.merchantId, auth.livemode ? 1 : 0];
	if (q.data.status) (where.push('status = ?'), args.push(q.data.status));
	if (q.data.location_id) (where.push('location_id = ?'), args.push(q.data.location_id));
	if (q.data.starting_after) {
		const cur = await getSignal(c.env.DB, auth.merchantId, q.data.starting_after);
		if (!cur) throw new ApiError(400, 'invalid_request', 'invalid_param', 'starting_after not found', 'starting_after');
		where.push('(received_at < ? OR (received_at = ? AND id < ?))');
		args.push(cur.received_at, cur.received_at, cur.id);
	}
	const rows = await c.env.DB.prepare(`SELECT * FROM signals WHERE ${where.join(' AND ')} ORDER BY received_at DESC, id DESC LIMIT ?`)
		.bind(...args, q.data.limit + 1)
		.all<SignalRow>();
	return c.json({ object: 'list', data: rows.results.slice(0, q.data.limit).map(presentSignal), has_more: rows.results.length > q.data.limit });
});

app.get('/v1/signals/:id', async (c) => c.json(presentSignal(await loadSignal(c, c.req.param('id')))));

app.post('/v1/signals/:id/assign', async (c) => {
	const auth = c.get('auth');
	const body = parseJson(await readBody(c), Assign);
	const sig = await loadSignal(c, c.req.param('id'));
	const row = await loadIntent(c, body.payment_intent);
	if (sig.location_id !== row.location_id) throw new ApiError(400, 'invalid_request', 'location_mismatch', 'signal and intent are at different locations', 'payment_intent');
	const i = unwrap(await locationStub(c.env, auth.merchantId, row.location_id, auth.livemode).markPaid(lctx(auth, row.location_id), row.id, sig.id, actor(c), null));
	return c.json(await intentResponse(c, overlay(row, i)));
});

for (const action of ['reject', 'ignore'] as const) {
	app.post(`/v1/signals/:id/${action}`, async (c) => {
		const auth = c.get('auth');
		const body = parseJson(await readBody(c), Reason);
		const sig = await loadSignal(c, c.req.param('id'));
		const stub = locationStub(c.env, auth.merchantId, sig.location_id, auth.livemode);
		const ctx = lctx(auth, sig.location_id);
		const s = unwrap(action === 'reject' ? await stub.rejectSignal(ctx, sig.id, actor(c), body.reason ?? null) : await stub.ignoreSignal(ctx, sig.id, actor(c), body.reason ?? null));
		return c.json(presentSignal({ ...sig, status: s.status, payment_intent_id: s.intentId, note: s.note }));
	});
}

// ----- webhook endpoints -----

app.post('/v1/webhook_endpoints', async (c) => {
	const auth = c.get('auth');
	const body = parseJson(await readBody(c), CreateEndpoint);
	const id = randomId('we');
	const secret = `whsec_${randomSecret()}`;
	const now = Date.now();
	await c.env.DB.prepare('INSERT INTO webhook_endpoints (id, merchant_id, livemode, url, events, secret_enc, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
		.bind(id, auth.merchantId, auth.livemode ? 1 : 0, body.url, JSON.stringify(body.events), await encryptSecret(c.env.WEBHOOK_KEY, secret), now)
		.run();
	return c.json({ id, object: 'webhook_endpoint', url: body.url, events: body.events, enabled: true, livemode: auth.livemode, secret, created: iso(now) }, 201);
});

app.get('/v1/webhook_endpoints', async (c) => {
	const auth = c.get('auth');
	const rows = await c.env.DB.prepare('SELECT id, url, events, enabled, created_at FROM webhook_endpoints WHERE merchant_id = ? AND livemode = ? ORDER BY created_at')
		.bind(auth.merchantId, auth.livemode ? 1 : 0)
		.all<{ id: string; url: string; events: string; enabled: number; created_at: number }>();
	return c.json({
		object: 'list',
		data: rows.results.map((r) => ({ id: r.id, object: 'webhook_endpoint', url: r.url, events: JSON.parse(r.events) as string[], enabled: r.enabled === 1, created: iso(r.created_at) })),
	});
});

// ---------- public (publishable key; no personal data) ----------

async function loadPublicIntent<E extends { Bindings: Env }>(c: Context<E>, id: string) {
	const auth = await authKey(c, 'publishable');
	const row = await getIntent(c.env.DB, auth.merchantId, id);
	if (!row || (row.livemode === 1) !== auth.livemode) throw notFound('payment intent');
	return { auth, row };
}

app.get('/v1/public/payment_intents/:id/status', async (c) => {
	const { row } = await loadPublicIntent(c, c.req.param('id'));
	return c.json(presentPublicStatus(row, Date.now()));
});

app.post('/v1/public/payment_intents/:id/claim', async (c) => {
	const { auth, row } = await loadPublicIntent(c, c.req.param('id'));
	const i = unwrap(await locationStub(c.env, auth.merchantId, row.location_id, auth.livemode).claim(lctx(auth, row.location_id), row.id));
	return c.json(presentPublicStatus(overlay(row, i), Date.now()));
});

// ---------- device API (merchant's phone) ----------

app.post('/device/v1/enroll', async (c) => {
	const body = parseJson(await readBody(c), Enroll);
	const now = Date.now();
	const hash = await sha256Hex(body.pairing_code);
	const pc = await c.env.DB.prepare('SELECT merchant_id, location_id, livemode, expires_at, used_at FROM pairing_codes WHERE code_hash = ?')
		.bind(hash)
		.first<{ merchant_id: string; location_id: string; livemode: number; expires_at: number; used_at: number | null }>();
	if (!pc || pc.used_at !== null || pc.expires_at <= now) throw unauthorized('pairing code is invalid or expired');
	const used = await c.env.DB.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').bind(now, hash).run();
	if (used.meta.changes !== 1) throw unauthorized('pairing code is invalid or expired');

	const deviceId = randomId('dev');
	const secret = randomSecret();
	const info = body.device_info;
	await c.env.DB.prepare(
		`INSERT INTO devices (id, merchant_id, location_id, livemode, label, secret_hash, secret_enc, model, android_version, app_version, status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
	)
		.bind(deviceId, pc.merchant_id, pc.location_id, pc.livemode, info.label ?? 'Phone', await sha256Hex(secret), await encryptSecret(c.env.DEVICE_KEY, secret), info.model ?? null, info.android_version ?? null, info.app_version ?? null, now)
		.run();
	return c.json({ device_id: deviceId, device_secret: secret, location_id: pc.location_id, livemode: pc.livemode === 1 }, 201);
});

/** Verifies the signature, records the nonce in the device's location object, and loads merchant settings. */
async function deviceRequest<E extends { Bindings: Env }>(c: Context<E>) {
	const { device, nonce, body } = await authDevice(c);
	const merchant = await getMerchant(c.env.DB, device.merchant_id);
	if (!merchant || merchant.status !== 'active') throw unauthorized();
	const livemode = device.livemode === 1;
	const stub = locationStub(c.env, device.merchant_id, device.location_id, livemode);
	unwrap(await stub.useNonce(device.id, nonce));
	const ctx: LocationCtx = { merchantId: device.merchant_id, locationId: device.location_id, livemode, settings: settingsFromJson(merchant.settings) };
	return { device, body, stub, ctx };
}

app.post('/device/v1/signals', async (c) => {
	const { device, body, stub, ctx } = await deviceRequest(c);
	const batch = parseJson(body, SignalBatch);
	const results = unwrap(
		await stub.ingest(
			ctx,
			device.id,
			device.clock_offset_ms,
			batch.signals.map((s) => ({
				app: s.app,
				amount: s.amount_paise,
				payerShort: shortPayer(s.payer_short),
				reference: s.reference ?? null,
				notificationKeyHash: s.notification_key_hash,
				postedAt: s.posted_at,
			})),
		),
	);
	await c.env.DB.prepare('UPDATE devices SET last_signal_at = ? WHERE id = ? AND merchant_id = ?').bind(Date.now(), device.id, device.merchant_id).run();
	return c.json({ results: results.map((r) => ({ ok: r.ok, signal_id: r.signalId ?? null, status: r.status ?? null, repeat: r.repeat ?? false, code: r.code ?? null })) });
});

app.post('/device/v1/heartbeat', async (c) => {
	const { device, body } = await deviceRequest(c);
	const hb = parseJson(body, Heartbeat);
	const now = Date.now();
	await c.env.DB.prepare(
		`UPDATE devices SET clock_offset_ms = ?, last_heartbeat_at = ?, listener_enabled = ?, app_version = COALESCE(?, app_version),
		 battery_optimized = COALESCE(?, battery_optimized), status = CASE WHEN status = 'revoked' THEN status ELSE 'online' END
		 WHERE id = ? AND merchant_id = ?`,
	)
		.bind(now - hb.device_time, now, hb.listener_connected ? 1 : 0, hb.app_version ?? null, hb.battery_optimized === undefined ? null : hb.battery_optimized ? 1 : 0, device.id, device.merchant_id)
		.run();
	return c.json({ ok: true, server_time: now });
});

app.get('/device/v1/parser_rules', async (c) => {
	await deviceRequest(c);
	const rules = await c.env.RULES.get('active');
	if (!rules) throw new ApiError(404, 'not_found', 'no_rules', 'no parser rules published yet');
	const version = (JSON.parse(rules) as { version?: string }).version ?? '';
	if (c.req.query('version') === version) return c.body(null, 304);
	return c.body(rules, 200, { 'content-type': 'application/json', etag: `"${version}"` });
});

// ---------- operator API (creating merchants until the dashboard exists) ----------

app.post('/admin/v1/merchants', async (c) => {
	const token = c.env.ADMIN_TOKEN;
	const given = /^Bearer\s+(.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
	if (!token || token.length < 32) throw notFound('route');
	if (!timingSafeEqual(given, token)) throw unauthorized();
	const body = parseJson(await readBody(c), CreateMerchant);
	const id = randomId('mer');
	const now = Date.now();
	await c.env.DB.prepare("INSERT INTO merchants (id, name, status, plan, settings, created_at) VALUES (?, ?, 'active', 'free', ?, ?)")
		.bind(id, body.name, JSON.stringify(body.settings ?? {}), now)
		.run();
	const keys = {
		secret_key_test: await makeKey(c.env.DB, id, 'secret', false, now),
		publishable_key_test: await makeKey(c.env.DB, id, 'publishable', false, now),
		secret_key_live: await makeKey(c.env.DB, id, 'secret', true, now),
		publishable_key_live: await makeKey(c.env.DB, id, 'publishable', true, now),
	};
	return c.json({ merchant: { id, name: body.name, created: iso(now) }, ...keys }, 201);
});
