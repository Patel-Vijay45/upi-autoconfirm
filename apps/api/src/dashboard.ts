// Endpoints the merchant dashboard needs: logins, team, API keys, phones, webhook logs, reports, settings.
// Merchant routes (/v1/…) run after the auth middleware, so they accept a session or a secret key, and
// every query is filtered by merchant_id (and livemode). Role checks use requireRole().
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
	decryptSecret,
	encryptSecret,
	formatPaise,
	newTotpSecret,
	otpauthUri,
	qrSvg,
	randomId,
	randomSecret,
	sha256Hex,
	timingSafeEqual,
	verifyTotp,
} from '@autoconfirm/core';
import type { Env } from './env.ts';
import { ApiError, notFound, unauthorized } from './errors.ts';
import { authSession, readBody, requireRole, SESSION_RE, type MerchantAuth, type Role } from './auth.ts';
import { getLocation, insertAuditStmt } from './db.ts';
import { hashPassword, PASSWORD_MIN, verifyPassword } from './passwords.ts';
import { iso } from './present.ts';
import { settingsFromJson } from './settings.ts';

type AppEnv = { Bindings: Env; Variables: { auth: MerchantAuth } };
type Ctx = Context<AppEnv>;

const SESSION_MS = 12 * 3600_000;
const INVITE_MS = 72 * 3600_000;
const THROTTLE_WINDOW_MS = 15 * 60_000;
const USER_ROLES = ['owner', 'admin', 'staff', 'developer'] as const;
const MFA_ROLES: Role[] = ['owner', 'admin'];

// ---------- helpers ----------

function parse<T extends z.ZodType>(raw: string, schema: T): z.infer<T> {
	let data: unknown;
	try {
		data = raw.trim() === '' ? {} : JSON.parse(raw);
	} catch {
		throw new ApiError(400, 'invalid_request', 'invalid_json', 'body is not valid JSON');
	}
	const r = schema.safeParse(data);
	if (!r.success) {
		const issue = r.error.issues[0];
		throw new ApiError(400, 'invalid_request', 'invalid_param', issue?.message ?? 'invalid request', issue?.path.join('.') || undefined);
	}
	return r.data;
}

function query<T extends z.ZodType>(c: Ctx, schema: T): z.infer<T> {
	const r = schema.safeParse(c.req.query());
	if (!r.success) throw new ApiError(400, 'invalid_request', 'invalid_param', r.error.issues[0]?.message ?? 'invalid query');
	return r.data;
}

function requireSession(auth: MerchantAuth): string {
	if (!auth.userId) throw new ApiError(403, 'permission', 'session_required', 'only signed-in dashboard users can do this');
	return auth.userId;
}

const ip = (c: Context) => c.req.header('cf-connecting-ip') ?? null;
const actorOf = (auth: MerchantAuth) => (auth.userId ? `user:${auth.userId}` : `key:${auth.keyPrefix}`);

async function audit(env: Env, auth: MerchantAuth, c: Context, action: string, objectId: string | null, detail: Record<string, unknown> = {}) {
	await insertAuditStmt(env.DB, { merchantId: auth.merchantId, actor: actorOf(auth), action, objectId, detail, ip: ip(c), at: Date.now() }).run();
}

async function createSession(env: Env, userId: string, merchantId: string, c: Context) {
	const token = `ses_${randomSecret()}`;
	const now = Date.now();
	await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, merchant_id, created_at, expires_at, last_seen_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.bind(await sha256Hex(token), userId, merchantId, now, now + SESSION_MS, now, ip(c))
		.run();
	await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(now, userId).run();
	return { token, expires_at: iso(now + SESSION_MS) };
}

async function throttled(env: Env, keys: { key: string; limit: number }[], now: number): Promise<boolean> {
	for (const { key, limit } of keys) {
		const r = await env.DB.prepare('SELECT failures, window_start FROM login_throttle WHERE key = ?').bind(key).first<{ failures: number; window_start: number }>();
		if (r && now - r.window_start < THROTTLE_WINDOW_MS && r.failures >= limit) return true;
	}
	return false;
}

async function recordFailure(env: Env, keys: string[], now: number) {
	for (const key of keys) {
		await env.DB.prepare(
			`INSERT INTO login_throttle (key, failures, window_start) VALUES (?, 1, ?)
			 ON CONFLICT(key) DO UPDATE SET
			   failures = CASE WHEN ? - window_start >= ? THEN 1 ELSE failures + 1 END,
			   window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END`,
		)
			.bind(key, now, now, THROTTLE_WINDOW_MS, now, THROTTLE_WINDOW_MS, now)
			.run();
	}
}

async function createInvite(env: Env, merchantId: string, email: string, role: (typeof USER_ROLES)[number]) {
	const now = Date.now();
	const existing = await env.DB.prepare('SELECT id, merchant_id, password_hash FROM users WHERE email = ? COLLATE NOCASE')
		.bind(email)
		.first<{ id: string; merchant_id: string; password_hash: string | null }>();
	let userId: string;
	if (existing) {
		// Re-inviting someone who never finished setup is fine; anything else is a conflict.
		if (existing.merchant_id !== merchantId || existing.password_hash !== null) throw new ApiError(409, 'conflict', 'email_in_use', 'this email already has an account');
		userId = existing.id;
		await env.DB.prepare('UPDATE users SET role = ? WHERE id = ? AND merchant_id = ?').bind(role, userId, merchantId).run();
	} else {
		userId = randomId('usr');
		await env.DB.prepare("INSERT INTO users (id, merchant_id, email, password_hash, role, mfa_secret, active, created_at) VALUES (?, ?, ?, NULL, ?, NULL, 0, ?)")
			.bind(userId, merchantId, email, role, now)
			.run();
	}
	const token = `inv_${randomSecret()}`;
	await env.DB.prepare('INSERT INTO user_invites (token_hash, merchant_id, user_id, mfa_secret_enc, expires_at) VALUES (?, ?, ?, ?, ?)')
		.bind(await sha256Hex(token), merchantId, userId, await encryptSecret(env.MFA_KEY, newTotpSecret()), now + INVITE_MS)
		.run();
	const base = env.DASHBOARD_URL?.replace(/\/$/, '');
	return { object: 'invite', user_id: userId, email, role, token, setup_url: base ? `${base}/setup/${token}` : null, expires_at: iso(now + INVITE_MS) };
}

async function loadInvite(env: Env, token: string) {
	if (!/^inv_[0-9A-Za-z]{40,64}$/.test(token)) return null;
	const row = await env.DB.prepare(
		`SELECT i.token_hash, i.merchant_id, i.user_id, i.mfa_secret_enc, i.expires_at, i.used_at, u.email, u.role, m.name AS merchant_name, m.status
		 FROM user_invites i JOIN users u ON u.id = i.user_id JOIN merchants m ON m.id = i.merchant_id
		 WHERE i.token_hash = ? AND u.merchant_id = i.merchant_id`,
	)
		.bind(await sha256Hex(token))
		.first<{ token_hash: string; merchant_id: string; user_id: string; mfa_secret_enc: string; expires_at: number; used_at: number | null; email: string; role: Role; merchant_name: string; status: string }>();
	if (!row || row.used_at !== null || row.expires_at <= Date.now() || row.status !== 'active') return null;
	return row;
}

function deviceStatus(d: { status: string; last_heartbeat_at: number | null }, now: number): string {
	if (d.status === 'revoked' || d.status === 'pending') return d.status;
	return d.last_heartbeat_at !== null && now - d.last_heartbeat_at < 11 * 60_000 ? 'online' : 'offline';
}

const IST_MS = 19_800_000;
const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istTime = (ms: number | null) => (ms === null ? '' : new Date(ms + IST_MS).toISOString().replace('T', ' ').slice(0, 19));

/** IST calendar days → [startMs, endMs). Defaults to the last 30 days. Max 92 days. */
function dayRange(from: string | undefined, to: string | undefined): [number, number] {
	const today = istDate(Date.now());
	const end = Date.parse(`${to ?? today}T00:00:00+05:30`) + 86_400_000;
	const start = from ? Date.parse(`${from}T00:00:00+05:30`) : end - 30 * 86_400_000;
	if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new ApiError(400, 'invalid_request', 'invalid_param', 'from/to must be YYYY-MM-DD with from <= to', 'from');
	if (end - start > 92 * 86_400_000) throw new ApiError(400, 'invalid_request', 'range_too_large', 'at most 92 days at a time', 'from');
	return [start, end];
}

/** CSV cell, with spreadsheet-formula injection blocked. */
function csv(v: unknown): string {
	let s = v === null || v === undefined ? '' : String(v);
	if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- schemas ----------

const Email = z.string().trim().toLowerCase().email().max(200);
const Login = z.object({ email: Email, password: z.string().min(1).max(200), otp: z.string().max(10).optional() }).strict();
const Invite = z.object({ email: Email, role: z.enum(USER_ROLES) }).strict();
const Setup = z.object({ password: z.string().min(PASSWORD_MIN, `password must be at least ${PASSWORD_MIN} characters`).max(200), otp: z.string().max(10).optional() }).strict();
const NewKey = z.object({ kind: z.enum(['secret', 'publishable']) }).strict();
const UpdateLocation = z.object({ name: z.string().min(1).max(80).optional(), active: z.boolean().optional() }).strict();
const Limit = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const DateQ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const UpdateSettings = z
	.object({
		auto_confirm_max: z.number().int().min(100).max(10_000_000).nullable().optional(),
		intent_ttl: z.number().int().min(120).max(10_800).optional(),
		max_intent_ttl: z.number().int().min(120).max(10_800).optional(),
		grace_window: z.number().int().min(0).max(21_600).optional(),
		reuse_cooldown: z.number().int().min(600).max(86_400).optional(),
		max_offset: z.number().int().min(1).max(99).optional(),
	})
	.strict();

// ---------- routes ----------

export function registerDashboard(app: Hono<AppEnv>) {
	// ----- login / logout (no session yet) -----

	app.post('/dashboard/v1/login', async (c) => {
		const body = parse(await readBody(c), Login);
		const now = Date.now();
		const keys = [
			{ key: `email:${body.email}`, limit: 5 },
			{ key: `ip:${ip(c) ?? 'unknown'}`, limit: 30 },
		];
		if (await throttled(c.env, keys, now)) throw new ApiError(429, 'rate_limit', 'too_many_attempts', 'too many failed logins; try again in 15 minutes');
		const user = await c.env.DB.prepare(
			`SELECT u.id, u.merchant_id, u.email, u.role, u.password_hash, u.mfa_secret, u.mfa_last_step, m.name AS merchant_name
			 FROM users u JOIN merchants m ON m.id = u.merchant_id
			 WHERE u.email = ? COLLATE NOCASE AND u.active = 1 AND m.status = 'active'`,
		)
			.bind(body.email)
			.first<{ id: string; merchant_id: string; email: string; role: Role; password_hash: string | null; mfa_secret: string | null; mfa_last_step: number | null; merchant_name: string }>();
		const passwordOk = await verifyPassword(body.password, user?.password_hash);
		if (!user || !passwordOk) {
			await recordFailure(c.env, keys.map((k) => k.key), now);
			throw new ApiError(401, 'authentication', 'invalid_login', 'wrong email or password');
		}
		if (user.mfa_secret) {
			if (!body.otp) throw new ApiError(401, 'authentication', 'otp_required', 'enter the 6-digit code from your authenticator app', 'otp');
			const step = await verifyTotp(await decryptSecret(c.env.MFA_KEY, user.mfa_secret), body.otp, now, user.mfa_last_step);
			if (step === null) {
				await recordFailure(c.env, keys.map((k) => k.key), now);
				throw new ApiError(401, 'authentication', 'invalid_otp', 'that code is wrong or was already used', 'otp');
			}
			await c.env.DB.prepare('UPDATE users SET mfa_last_step = ? WHERE id = ?').bind(step, user.id).run();
		}
		await c.env.DB.prepare('DELETE FROM login_throttle WHERE key = ?').bind(keys[0]!.key).run();
		const session = await createSession(c.env, user.id, user.merchant_id, c);
		return c.json({ ...session, user: { id: user.id, email: user.email, role: user.role }, merchant: { id: user.merchant_id, name: user.merchant_name } });
	});

	app.post('/dashboard/v1/logout', async (c) => {
		const m = SESSION_RE.exec(c.req.header('authorization') ?? '');
		if (m) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(m[1]!)).run();
		return c.json({ ok: true });
	});

	app.get('/dashboard/v1/me', async (c) => {
		const auth = await authSession(c.env, c.req.header('authorization') ?? '', c.req.header('autoconfirm-mode'));
		const u = await c.env.DB.prepare('SELECT u.id, u.email, u.role, u.mfa_secret IS NOT NULL AS mfa, m.id AS merchant_id, m.name FROM users u JOIN merchants m ON m.id = u.merchant_id WHERE u.id = ? AND u.merchant_id = ?')
			.bind(auth.userId, auth.merchantId)
			.first<{ id: string; email: string; role: Role; mfa: number; merchant_id: string; name: string }>();
		if (!u) throw unauthorized();
		return c.json({ user: { id: u.id, email: u.email, role: u.role, mfa: u.mfa === 1 }, merchant: { id: u.merchant_id, name: u.name }, livemode: auth.livemode });
	});

	// ----- invites: set a password (and enrol TOTP) from a one-time link -----

	app.get('/dashboard/v1/invites/:token', async (c) => {
		const inv = await loadInvite(c.env, c.req.param('token'));
		if (!inv) throw notFound('invite');
		const secret = await decryptSecret(c.env.MFA_KEY, inv.mfa_secret_enc);
		const uri = otpauthUri(secret, inv.email, `AutoConfirm (${inv.merchant_name})`);
		return c.json({ email: inv.email, role: inv.role, merchant_name: inv.merchant_name, mfa_required: MFA_ROLES.includes(inv.role), totp: { secret, otpauth_uri: uri, qr_svg: qrSvg(uri, { label: 'Authenticator setup QR code' }) } });
	});

	app.post('/dashboard/v1/invites/:token', async (c) => {
		const body = parse(await readBody(c), Setup);
		const inv = await loadInvite(c.env, c.req.param('token'));
		if (!inv) throw notFound('invite');
		const mfaRequired = MFA_ROLES.includes(inv.role);
		let step: number | null = null;
		if (body.otp || mfaRequired) {
			if (!body.otp) throw new ApiError(400, 'invalid_request', 'otp_required', 'scan the QR code with an authenticator app and enter its 6-digit code', 'otp');
			step = await verifyTotp(await decryptSecret(c.env.MFA_KEY, inv.mfa_secret_enc), body.otp, Date.now());
			if (step === null) throw new ApiError(400, 'invalid_request', 'invalid_otp', 'that code is wrong; check the time on your phone and try again', 'otp');
		}
		const now = Date.now();
		const used = await c.env.DB.prepare('UPDATE user_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').bind(now, inv.token_hash, now).run();
		if (used.meta.changes !== 1) throw notFound('invite');
		await c.env.DB.prepare('UPDATE users SET password_hash = ?, mfa_secret = ?, mfa_last_step = ?, active = 1 WHERE id = ? AND merchant_id = ?')
			.bind(await hashPassword(body.password), step !== null ? inv.mfa_secret_enc : null, step, inv.user_id, inv.merchant_id)
			.run();
		const session = await createSession(c.env, inv.user_id, inv.merchant_id, c);
		return c.json({ ...session, user: { id: inv.user_id, email: inv.email, role: inv.role }, merchant: { id: inv.merchant_id, name: inv.merchant_name } }, 201);
	});

	app.post('/admin/v1/merchants/:id/invites', async (c) => {
		const token = c.env.ADMIN_TOKEN;
		const given = /^Bearer\s+(.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
		if (!token || token.length < 32) throw notFound('route');
		if (!timingSafeEqual(given, token)) throw unauthorized();
		const body = parse(await readBody(c), Invite);
		const m = await c.env.DB.prepare('SELECT id FROM merchants WHERE id = ?').bind(c.req.param('id')).first();
		if (!m) throw notFound('merchant');
		return c.json(await createInvite(c.env, c.req.param('id'), body.email, body.role), 201);
	});

	// ----- team -----

	app.get('/v1/users', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'owner', 'admin');
		const rows = await c.env.DB.prepare('SELECT id, email, role, active, mfa_secret IS NOT NULL AS mfa, password_hash IS NOT NULL AS setup_done, created_at, last_login FROM users WHERE merchant_id = ? ORDER BY created_at')
			.bind(auth.merchantId)
			.all<{ id: string; email: string; role: Role; active: number; mfa: number; setup_done: number; created_at: number; last_login: number | null }>();
		return c.json({
			object: 'list',
			data: rows.results.map((u) => ({ id: u.id, object: 'user', email: u.email, role: u.role, active: u.active === 1, mfa: u.mfa === 1, invited: u.setup_done !== 1, created: iso(u.created_at), last_login: iso(u.last_login) })),
		});
	});

	app.post('/v1/users/invites', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'owner', 'admin');
		const body = parse(await readBody(c), Invite);
		if (body.role === 'owner' && auth.role !== 'owner') throw new ApiError(403, 'permission', 'forbidden', 'only an owner can invite another owner');
		const inv = await createInvite(c.env, auth.merchantId, body.email, body.role);
		await audit(c.env, auth, c, 'user.invite', inv.user_id, { email: body.email, role: body.role });
		return c.json(inv, 201);
	});

	app.post('/v1/users/:id/deactivate', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'owner', 'admin');
		const id = c.req.param('id');
		if (id === auth.userId) throw new ApiError(400, 'invalid_request', 'cannot_deactivate_self', 'you cannot deactivate yourself');
		const u = await c.env.DB.prepare('SELECT role FROM users WHERE id = ? AND merchant_id = ?').bind(id, auth.merchantId).first<{ role: Role }>();
		if (!u) throw notFound('user');
		if (u.role === 'owner' && auth.role !== 'owner') throw new ApiError(403, 'permission', 'forbidden', 'only an owner can deactivate an owner');
		await c.env.DB.batch([
			c.env.DB.prepare('UPDATE users SET active = 0 WHERE id = ? AND merchant_id = ?').bind(id, auth.merchantId),
			c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND merchant_id = ?').bind(id, auth.merchantId),
		]);
		await audit(c.env, auth, c, 'user.deactivate', id);
		return c.json({ id, object: 'user', active: false });
	});

	// ----- API keys (dashboard users only; the full key is shown once) -----

	app.get('/v1/api_keys', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'owner', 'admin', 'developer');
		const rows = await c.env.DB.prepare('SELECT id, kind, livemode, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE merchant_id = ? AND livemode = ? ORDER BY created_at DESC')
			.bind(auth.merchantId, auth.livemode ? 1 : 0)
			.all<{ id: string; kind: string; livemode: number; prefix: string; created_at: number; last_used_at: number | null; revoked_at: number | null }>();
		return c.json({
			object: 'list',
			data: rows.results.map((k) => ({ id: k.id, object: 'api_key', kind: k.kind, livemode: k.livemode === 1, prefix: k.prefix, created: iso(k.created_at), last_used: iso(k.last_used_at), revoked: k.revoked_at !== null })),
		});
	});

	app.post('/v1/api_keys', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'owner', 'admin', 'developer');
		requireSession(auth);
		if (auth.livemode && auth.role === 'developer') throw new ApiError(403, 'permission', 'forbidden', 'developers can create test keys only');
		const body = parse(await readBody(c), NewKey);
		const key = `${body.kind === 'secret' ? 'sk' : 'pk'}_${auth.livemode ? 'live' : 'test'}_${randomSecret()}`;
		const id = randomId('key');
		const now = Date.now();
		await c.env.DB.prepare('INSERT INTO api_keys (id, merchant_id, kind, livemode, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.bind(id, auth.merchantId, body.kind, auth.livemode ? 1 : 0, key.slice(0, 12), await sha256Hex(key), now)
			.run();
		await audit(c.env, auth, c, 'key.create', id, { kind: body.kind, livemode: auth.livemode });
		return c.json({ id, object: 'api_key', kind: body.kind, livemode: auth.livemode, prefix: key.slice(0, 12), key, created: iso(now) }, 201);
	});

	app.post('/v1/api_keys/:id/revoke', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'owner', 'admin', 'developer');
		requireSession(auth);
		if (auth.livemode && auth.role === 'developer') throw new ApiError(403, 'permission', 'forbidden', 'developers can revoke test keys only');
		const r = await c.env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND merchant_id = ? AND livemode = ? AND revoked_at IS NULL')
			.bind(Date.now(), c.req.param('id'), auth.merchantId, auth.livemode ? 1 : 0)
			.run();
		if (r.meta.changes !== 1) throw notFound('api key');
		await audit(c.env, auth, c, 'key.revoke', c.req.param('id'));
		return c.json({ id: c.req.param('id'), object: 'api_key', revoked: true });
	});

	// ----- phones -----

	app.get('/v1/devices', async (c) => {
		const auth = c.get('auth');
		const q = query(c, z.object({ location_id: z.string().max(64).optional() }));
		const now = Date.now();
		const rows = await c.env.DB.prepare(
			`SELECT id, location_id, label, model, android_version, app_version, status, listener_enabled, battery_optimized, last_heartbeat_at, last_signal_at, created_at
			 FROM devices WHERE merchant_id = ? AND livemode = ? ${q.location_id ? 'AND location_id = ?' : ''} ORDER BY created_at`,
		)
			.bind(...[auth.merchantId, auth.livemode ? 1 : 0, ...(q.location_id ? [q.location_id] : [])])
			.all<{ id: string; location_id: string; label: string; model: string | null; android_version: string | null; app_version: string | null; status: string; listener_enabled: number; battery_optimized: number | null; last_heartbeat_at: number | null; last_signal_at: number | null; created_at: number }>();
		return c.json({
			object: 'list',
			data: rows.results.map((d) => ({
				id: d.id,
				object: 'device',
				location_id: d.location_id,
				label: d.label,
				model: d.model,
				android_version: d.android_version,
				app_version: d.app_version,
				status: deviceStatus(d, now),
				listener_enabled: d.listener_enabled === 1,
				battery_optimized: d.battery_optimized === null ? null : d.battery_optimized === 1,
				last_heartbeat: iso(d.last_heartbeat_at),
				last_signal: iso(d.last_signal_at),
				created: iso(d.created_at),
			})),
		});
	});

	app.post('/v1/devices/:id/revoke', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'key', 'owner', 'admin');
		const r = await c.env.DB.prepare("UPDATE devices SET status = 'revoked' WHERE id = ? AND merchant_id = ? AND livemode = ? AND status != 'revoked'")
			.bind(c.req.param('id'), auth.merchantId, auth.livemode ? 1 : 0)
			.run();
		if (r.meta.changes !== 1) throw notFound('device');
		await audit(c.env, auth, c, 'device.revoke', c.req.param('id'));
		return c.json({ id: c.req.param('id'), object: 'device', status: 'revoked' });
	});

	app.post('/v1/locations/:id', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'key', 'owner', 'admin');
		const body = parse(await readBody(c), UpdateLocation);
		const loc = await getLocation(c.env.DB, auth.merchantId, c.req.param('id'));
		if (!loc) throw notFound('location');
		const name = body.name ?? loc.name;
		const active = body.active === undefined ? loc.active : body.active ? 1 : 0;
		await c.env.DB.prepare('UPDATE locations SET name = ?, active = ? WHERE id = ? AND merchant_id = ?').bind(name, active, loc.id, auth.merchantId).run();
		await audit(c.env, auth, c, 'location.update', loc.id, body);
		return c.json({ id: loc.id, object: 'location', name, upi_vpa: loc.upi_vpa, upi_payee_name: loc.upi_payee_name, active: active === 1, created: iso(loc.created_at) });
	});

	// ----- webhooks: enable/disable, delivery log, events, resend -----

	for (const action of ['enable', 'disable'] as const) {
		app.post(`/v1/webhook_endpoints/:id/${action}`, async (c) => {
			const auth = c.get('auth');
			requireRole(auth, 'key', 'owner', 'admin', 'developer');
			const r = await c.env.DB.prepare('UPDATE webhook_endpoints SET enabled = ? WHERE id = ? AND merchant_id = ? AND livemode = ?')
				.bind(action === 'enable' ? 1 : 0, c.req.param('id'), auth.merchantId, auth.livemode ? 1 : 0)
				.run();
			if (r.meta.changes !== 1) throw notFound('webhook endpoint');
			await audit(c.env, auth, c, `webhook.${action}`, c.req.param('id'));
			return c.json({ id: c.req.param('id'), object: 'webhook_endpoint', enabled: action === 'enable' });
		});
	}

	app.get('/v1/webhook_deliveries', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'key', 'owner', 'admin', 'developer');
		const q = query(c, Limit.extend({ endpoint_id: z.string().max(64).optional() }));
		const rows = await c.env.DB.prepare(
			`SELECT d.id, d.event_id, d.endpoint_id, d.attempt, d.status, d.http_status, d.error, d.next_attempt_at, d.created_at, e.type
			 FROM webhook_deliveries d JOIN events e ON e.id = d.event_id AND e.merchant_id = d.merchant_id
			 WHERE d.merchant_id = ? AND e.livemode = ? ${q.endpoint_id ? 'AND d.endpoint_id = ?' : ''}
			 ORDER BY d.id DESC LIMIT ?`,
		)
			.bind(...[auth.merchantId, auth.livemode ? 1 : 0, ...(q.endpoint_id ? [q.endpoint_id] : []), q.limit])
			.all<{ id: number; event_id: string; endpoint_id: string; attempt: number; status: string; http_status: number | null; error: string | null; next_attempt_at: number | null; created_at: number; type: string }>();
		return c.json({
			object: 'list',
			data: rows.results.map((d) => ({ id: d.id, event: d.event_id, type: d.type, endpoint: d.endpoint_id, attempt: d.attempt, status: d.status, http_status: d.http_status, error: d.error, next_attempt: iso(d.next_attempt_at), created: iso(d.created_at) })),
		});
	});

	app.get('/v1/events', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'key', 'owner', 'admin', 'developer');
		const q = query(c, Limit.extend({ type: z.string().max(60).optional() }));
		const rows = await c.env.DB.prepare(`SELECT id, type, object_id, created_at FROM events WHERE merchant_id = ? AND livemode = ? ${q.type ? 'AND type = ?' : ''} ORDER BY created_at DESC LIMIT ?`)
			.bind(...[auth.merchantId, auth.livemode ? 1 : 0, ...(q.type ? [q.type] : []), q.limit])
			.all<{ id: string; type: string; object_id: string; created_at: number }>();
		return c.json({ object: 'list', data: rows.results.map((e) => ({ id: e.id, object: 'event', type: e.type, object_id: e.object_id, created: iso(e.created_at) })) });
	});

	app.post('/v1/events/:id/resend', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'key', 'owner', 'admin', 'developer');
		const ev = await c.env.DB.prepare('SELECT id FROM events WHERE id = ? AND merchant_id = ? AND livemode = ?').bind(c.req.param('id'), auth.merchantId, auth.livemode ? 1 : 0).first<{ id: string }>();
		if (!ev) throw notFound('event');
		await c.env.WEBHOOKS.send({ eventId: ev.id, merchantId: auth.merchantId });
		await audit(c.env, auth, c, 'event.resend', ev.id);
		return c.json({ id: ev.id, object: 'event', resent: true });
	});

	// ----- reports (days are IST) -----

	app.get('/v1/reports/summary', async (c) => {
		const auth = c.get('auth');
		const q = query(c, z.object({ from: DateQ, to: DateQ, location_id: z.string().max(64).optional() }));
		const [start, end] = dayRange(q.from, q.to);
		const loc = q.location_id ? 'AND pi.location_id = ?' : '';
		const locArg = q.location_id ? [q.location_id] : [];
		const paid = await c.env.DB.prepare(
			`SELECT date((pi.paid_at + ${IST_MS}) / 1000, 'unixepoch') AS day, COUNT(*) AS paid_count, SUM(pi.amount) AS amount,
			        SUM(COALESCE(s.amount, pi.unique_amount)) AS received, SUM(CASE WHEN pi.paid_source = 'auto' THEN 1 ELSE 0 END) AS auto_count,
			        SUM(pi.late) AS late_count, SUM(pi.amount_mismatch) AS mismatch_count
			 FROM payment_intents pi LEFT JOIN signals s ON s.id = pi.matched_signal_id AND s.merchant_id = pi.merchant_id
			 WHERE pi.merchant_id = ? AND pi.livemode = ? AND pi.status = 'paid' AND pi.paid_at >= ? AND pi.paid_at < ? ${loc}
			 GROUP BY day ORDER BY day`,
		)
			.bind(auth.merchantId, auth.livemode ? 1 : 0, start, end, ...locArg)
			.all<{ day: string; paid_count: number; amount: number; received: number; auto_count: number; late_count: number; mismatch_count: number }>();
		const inbox = await c.env.DB.prepare(
			`SELECT date((received_at + ${IST_MS}) / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM signals pi
			 WHERE merchant_id = ? AND livemode = ? AND status IN ('unmatched', 'ambiguous', 'review') AND received_at >= ? AND received_at < ? ${loc}
			 GROUP BY day`,
		)
			.bind(auth.merchantId, auth.livemode ? 1 : 0, start, end, ...locArg)
			.all<{ day: string; n: number }>();
		const open = new Map(inbox.results.map((r) => [r.day, r.n]));
		const days = paid.results.map((d) => ({ ...d, open_inbox: open.get(d.day) ?? 0, received_display: formatPaise(d.received) }));
		for (const [day, n] of open) if (!days.some((d) => d.day === day)) days.push({ day, paid_count: 0, amount: 0, received: 0, auto_count: 0, late_count: 0, mismatch_count: 0, open_inbox: n, received_display: '0.00' });
		days.sort((a, b) => a.day.localeCompare(b.day));
		const total = days.reduce((t, d) => ({ paid_count: t.paid_count + d.paid_count, received: t.received + d.received, auto_count: t.auto_count + d.auto_count, open_inbox: t.open_inbox + d.open_inbox }), { paid_count: 0, received: 0, auto_count: 0, open_inbox: 0 });
		return c.json({ object: 'report', from: istDate(start), to: istDate(end - 1), days, total: { ...total, received_display: formatPaise(total.received) } });
	});

	app.get('/v1/reports/payments.csv', async (c) => {
		const auth = c.get('auth');
		const q = query(c, z.object({ from: DateQ, to: DateQ }));
		const [start, end] = dayRange(q.from, q.to);
		const rows = await c.env.DB.prepare(
			`SELECT pi.id, pi.order_id, pi.status, pi.amount, pi.unique_amount, COALESCE(s.amount, CASE WHEN pi.status = 'paid' THEN pi.unique_amount END) AS received,
			        pi.created_at, pi.paid_at, pi.paid_source, pi.late, pi.amount_mismatch, l.name AS location
			 FROM payment_intents pi
			 LEFT JOIN signals s ON s.id = pi.matched_signal_id AND s.merchant_id = pi.merchant_id
			 LEFT JOIN locations l ON l.id = pi.location_id AND l.merchant_id = pi.merchant_id
			 WHERE pi.merchant_id = ? AND pi.livemode = ? AND pi.created_at >= ? AND pi.created_at < ?
			 ORDER BY pi.created_at LIMIT 20000`,
		)
			.bind(auth.merchantId, auth.livemode ? 1 : 0, start, end)
			.all<{ id: string; order_id: string | null; status: string; amount: number; unique_amount: number; received: number | null; created_at: number; paid_at: number | null; paid_source: string | null; late: number; amount_mismatch: number; location: string | null }>();
		const header = ['payment_id', 'order_id', 'status', 'amount_inr', 'pay_amount_inr', 'received_inr', 'created_ist', 'paid_ist', 'source', 'late', 'amount_mismatch', 'location'];
		const lines = [header.join(',')];
		for (const r of rows.results) {
			lines.push(
				[r.id, r.order_id, r.status, formatPaise(r.amount), formatPaise(r.unique_amount), r.received === null ? '' : formatPaise(r.received), istTime(r.created_at), istTime(r.paid_at), r.paid_source, r.late ? 'yes' : '', r.amount_mismatch ? 'yes' : '', r.location]
					.map(csv)
					.join(','),
			);
		}
		return c.body(lines.join('\r\n') + '\r\n', 200, {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="payments-${istDate(start)}-to-${istDate(end - 1)}.csv"`,
			'cache-control': 'no-store',
		});
	});

	// ----- settings (MATCHING.md §1.1; times in seconds) -----

	const settingsView = (json: string | null) => {
		const s = settingsFromJson(json);
		return {
			object: 'settings',
			offset_mode: s.offsetMode,
			max_offset: s.maxOffset,
			intent_ttl: s.intentTtlMs / 1000,
			max_intent_ttl: s.maxIntentTtlMs / 1000,
			grace_window: s.graceMs / 1000,
			reuse_cooldown: s.reuseCooldownMs / 1000,
			auto_confirm_max: s.autoConfirmMax,
			min_amount: s.minAmount,
			max_amount: s.maxAmount,
		};
	};

	app.get('/v1/settings', async (c) => {
		const auth = c.get('auth');
		const m = await c.env.DB.prepare('SELECT settings FROM merchants WHERE id = ?').bind(auth.merchantId).first<{ settings: string }>();
		return c.json(settingsView(m?.settings ?? '{}'));
	});

	app.post('/v1/settings', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'owner', 'admin');
		requireSession(auth);
		const body = parse(await readBody(c), UpdateSettings);
		const m = await c.env.DB.prepare('SELECT settings FROM merchants WHERE id = ?').bind(auth.merchantId).first<{ settings: string }>();
		let current: Record<string, unknown> = {};
		try {
			current = JSON.parse(m?.settings ?? '{}') as Record<string, unknown>;
		} catch {
			current = {};
		}
		const next = JSON.stringify({ ...current, ...body });
		await c.env.DB.prepare('UPDATE merchants SET settings = ? WHERE id = ?').bind(next, auth.merchantId).run();
		await audit(c.env, auth, c, 'settings.update', auth.merchantId, body);
		return c.json(settingsView(next));
	});

	// ----- audit log -----

	app.get('/v1/audit_log', async (c) => {
		const auth = c.get('auth');
		requireRole(auth, 'owner', 'admin');
		const q = query(c, Limit);
		const rows = await c.env.DB.prepare(
			`SELECT a.id, a.actor, a.action, a.object_id, a.detail, a.at, u.email
			 FROM audit_log a LEFT JOIN users u ON a.actor = 'user:' || u.id AND u.merchant_id = a.merchant_id
			 WHERE a.merchant_id = ? ORDER BY a.id DESC LIMIT ?`,
		)
			.bind(auth.merchantId, q.limit)
			.all<{ id: number; actor: string; action: string; object_id: string | null; detail: string; at: number; email: string | null }>();
		return c.json({
			object: 'list',
			data: rows.results.map((a) => ({ id: a.id, actor: a.email ?? a.actor, action: a.action, object_id: a.object_id, detail: JSON.parse(a.detail || '{}') as unknown, at: iso(a.at) })),
		});
	});
}
