// Projects inside a merchant: one UPI ID (so one pool of unique amounts and one phone), several websites/apps.
// A project's API keys see and create only that project's payments, webhook endpoints and events.
import type { Env } from './env.ts';
import { ApiError } from './errors.ts';
import type { MerchantAuth } from './auth.ts';

/** What a project key may call. Everything else is shop-level (counters, phones, inbox, team, settings). */
const PROJECT_KEY_ROUTES: [string, RegExp][] = [
	['POST', /^\/v1\/payment_intents$/],
	['GET', /^\/v1\/payment_intents(\/[^/]+)?$/],
	['POST', /^\/v1\/payment_intents\/[^/]+\/(cancel|mark_paid|unmark_paid)$/],
	['GET', /^\/v1\/locations$/],
	['POST', /^\/v1\/webhook_endpoints$/],
	['GET', /^\/v1\/webhook_endpoints$/],
	['POST', /^\/v1\/webhook_endpoints\/[^/]+\/(enable|disable)$/],
	['GET', /^\/v1\/webhook_deliveries$/],
	['GET', /^\/v1\/events$/],
	['POST', /^\/v1\/events\/[^/]+\/resend$/],
];

export function requireProjectScope(auth: MerchantAuth, method: string, path: string): void {
	if (!auth.projectId) return;
	if (PROJECT_KEY_ROUTES.some(([m, re]) => m === method && re.test(path))) return;
	throw new ApiError(403, 'permission', 'project_key_scope', "a project's API key can't do this; use a shop-wide key or the dashboard");
}

/** Can this caller see a row of this project? Merchant-wide callers see every project. */
export function inProject(auth: MerchantAuth, rowProjectId: string | null | undefined): boolean {
	return !auth.projectId || rowProjectId === auth.projectId;
}

/** `AND <col> = ?` for a project key, or a requested project filter; nothing for merchant-wide callers. */
export function projectWhere(auth: MerchantAuth, requested: string | undefined, col = 'project_id'): { sql: string; args: unknown[] } {
	const id = auth.projectId ?? requested;
	return id ? { sql: ` AND ${col} = ?`, args: [id] } : { sql: '', args: [] };
}

/**
 * The project a new payment or webhook endpoint belongs to: always the key's own project for a project key;
 * otherwise the requested one (must be this merchant's, and active), or none.
 */
export async function resolveProject(env: Env, auth: MerchantAuth, requested: string | undefined): Promise<string | null> {
	if (auth.projectId) {
		if (requested && requested !== auth.projectId) throw new ApiError(403, 'permission', 'project_key_scope', "this key belongs to another project", 'project_id');
		return auth.projectId;
	}
	if (!requested) return null;
	const p = await env.DB.prepare('SELECT active FROM projects WHERE id = ? AND merchant_id = ?').bind(requested, auth.merchantId).first<{ active: number }>();
	if (!p) throw new ApiError(404, 'not_found', 'not_found', 'project not found', 'project_id');
	if (p.active !== 1) throw new ApiError(422, 'invalid_request', 'project_paused', 'this project is paused', 'project_id');
	return requested;
}

/**
 * One UPI ID belongs to one merchant. Two merchants with the same UPI ID would each hand out amounts on their
 * own, so one payment could mark orders paid in both. Several websites on one UPI ID = projects in one merchant.
 */
export async function upiIdUsedByAnotherMerchant(env: Env, merchantId: string, vpa: string): Promise<boolean> {
	const row = await env.DB.prepare('SELECT 1 AS x FROM locations WHERE upi_vpa = ? COLLATE NOCASE AND merchant_id != ? AND active = 1 LIMIT 1')
		.bind(vpa, merchantId)
		.first<{ x: number }>();
	return row !== null;
}

export const upiIdElsewhereError = () =>
	new ApiError(
		409,
		'conflict',
		'upi_id_in_use_elsewhere',
		'this UPI ID is already used by another AutoConfirm account. One UPI ID belongs to one account: add a project in that account instead.',
		'upi_vpa',
	);
