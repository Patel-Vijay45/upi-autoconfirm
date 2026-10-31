import type { Context } from 'hono';
import { decryptSecret, sha256Hex, verifyDeviceRequest, type Settings } from '@autoconfirm/core';
import type { Env } from './env.ts';
import { ApiError, unauthorized } from './errors.ts';
import { getDevice, type DeviceRow } from './db.ts';
import { settingsFromJson } from './settings.ts';

/** 'key' = a secret/publishable API key; the others are dashboard users. */
export type Role = 'key' | 'owner' | 'admin' | 'staff' | 'developer';

export interface MerchantAuth {
	merchantId: string;
	livemode: boolean;
	keyPrefix: string;
	settings: Settings;
	role: Role;
	/** Set for dashboard sessions. */
	userId: string | null;
}

/** 403 unless the caller has one of these roles. API keys pass only if 'key' is listed. */
export function requireRole(auth: MerchantAuth, ...roles: Role[]): void {
	if (!roles.includes(auth.role)) throw new ApiError(403, 'permission', 'forbidden', 'your role is not allowed to do this');
}

export const SESSION_RE = /^Bearer\s+(ses_[0-9A-Za-z]{40,64})$/;
const SESSION_TOUCH_MS = 5 * 60_000;

/**
 * A dashboard session (Authorization: Bearer ses_…). The dashboard picks test or live data with the
 * AutoConfirm-Mode header ("live" or "test", default test).
 */
export async function authSession(env: Env, authorization: string, mode: string | undefined): Promise<MerchantAuth> {
	const m = SESSION_RE.exec(authorization);
	if (!m) throw unauthorized();
	const now = Date.now();
	const row = await env.DB.prepare(
		`SELECT s.token_hash, s.user_id, s.merchant_id, s.last_seen_at, u.role, u.active, m.status, m.settings
		 FROM sessions s JOIN users u ON u.id = s.user_id JOIN merchants m ON m.id = s.merchant_id
		 WHERE s.token_hash = ? AND s.expires_at > ? AND u.merchant_id = s.merchant_id`,
	)
		.bind(await sha256Hex(m[1]!), now)
		.first<{ token_hash: string; user_id: string; merchant_id: string; last_seen_at: number; role: Role; active: number; status: string; settings: string }>();
	if (!row || row.active !== 1 || row.status !== 'active') throw unauthorized('session expired, please log in again');
	if (now - row.last_seen_at > SESSION_TOUCH_MS) {
		await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').bind(now, row.token_hash).run();
	}
	return {
		merchantId: row.merchant_id,
		livemode: mode === 'live',
		keyPrefix: `user:${row.user_id}`,
		settings: settingsFromJson(row.settings),
		role: row.role,
		userId: row.user_id,
	};
}

/** Secret key or dashboard session. */
export async function authMerchant<E extends { Bindings: Env }>(c: Context<E>): Promise<MerchantAuth> {
	const header = c.req.header('authorization') ?? '';
	if (SESSION_RE.test(header)) return authSession(c.env, header, c.req.header('autoconfirm-mode'));
	return authKeyValue(c.env, header, 'secret');
}

const KEY_RE = /^Bearer\s+((sk|pk)_(live|test)_[0-9A-Za-z]{20,64})$/;

/** Authenticate a secret (sk_) or publishable (pk_) key. Keys are looked up by SHA-256 hash only. */
export async function authKey<E extends { Bindings: Env }>(c: Context<E>, kind: 'secret' | 'publishable'): Promise<MerchantAuth> {
	return authKeyValue(c.env, c.req.header('authorization') ?? '', kind);
}

/** Same as authKey, for a raw "Bearer …" value (e.g. a WebSocket ?key= that browsers can't send as a header). */
export async function authKeyValue(env: Env, authorization: string, kind: 'secret' | 'publishable'): Promise<MerchantAuth> {
	const m = KEY_RE.exec(authorization);
	if (!m) throw unauthorized();
	if ((m[2] === 'sk') !== (kind === 'secret')) throw unauthorized(kind === 'secret' ? 'a secret key (sk_) is required' : 'a publishable key (pk_) is required');
	const hash = await sha256Hex(m[1]!);
	const row = await env.DB.prepare(
		`SELECT k.merchant_id, k.livemode, k.prefix, m.status, m.settings
		 FROM api_keys k JOIN merchants m ON m.id = k.merchant_id
		 WHERE k.key_hash = ? AND k.kind = ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)`,
	)
		.bind(hash, kind, Date.now())
		.first<{ merchant_id: string; livemode: number; prefix: string; status: string; settings: string }>();
	if (!row || row.status !== 'active') throw unauthorized();
	return { merchantId: row.merchant_id, livemode: row.livemode === 1, keyPrefix: row.prefix, settings: settingsFromJson(row.settings), role: 'key', userId: null };
}

export interface DeviceAuth {
	device: DeviceRow;
	nonce: string;
	body: string;
}

export const MAX_BODY_BYTES = 16 * 1024;

export async function readBody<E extends { Bindings: Env }>(c: Context<E>): Promise<string> {
	const len = Number(c.req.header('content-length') ?? '0');
	if (len > MAX_BODY_BYTES) throw new ApiError(413, 'invalid_request', 'body_too_large', 'request body is too large');
	const text = await c.req.text();
	if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new ApiError(413, 'invalid_request', 'body_too_large', 'request body is too large');
	return text;
}

/** Verify an HMAC-signed device request (API.md §8). The caller must still record the nonce. */
export async function authDevice<E extends { Bindings: Env }>(c: Context<E>): Promise<DeviceAuth> {
	const deviceId = c.req.header('x-device-id');
	const timestamp = c.req.header('x-timestamp');
	const nonce = c.req.header('x-nonce');
	const signature = c.req.header('x-signature');
	if (!deviceId || !timestamp || !nonce || !signature) throw unauthorized('missing device signature headers');
	const body = await readBody(c);
	const device = await getDevice(c.env.DB, deviceId);
	if (!device || device.status === 'revoked') throw unauthorized();
	const secret = await decryptSecret(c.env.DEVICE_KEY, device.secret_enc);
	const url = new URL(c.req.url);
	const result = await verifyDeviceRequest(
		secret,
		{ method: c.req.method, path: url.pathname + url.search, timestamp, nonce, body },
		signature,
		Math.floor(Date.now() / 1000),
	);
	if (!result.ok) throw unauthorized(`device signature rejected: ${result.reason}`);
	return { device, nonce, body };
}
