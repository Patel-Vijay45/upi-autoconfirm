// Calls the AutoConfirm API as the signed-in user. All access rules live in the API.
import { env } from '$env/dynamic/private';
import { error, redirect, type RequestEvent } from '@sveltejs/kit';

export class ApiFailure extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly param?: string,
	) {
		super(message);
	}
}

export const SESSION_COOKIE = 'ac_session';
export const MODE_COOKIE = 'ac_mode';

export async function apiRaw(event: RequestEvent, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
	const headers = new Headers({ 'autoconfirm-mode': event.locals.mode, ...extraHeaders });
	// Forward the customer's IP so the API's login throttling is per person, not per dashboard.
	try {
		headers.set('cf-connecting-ip', event.getClientAddress());
	} catch {
		/* not available in some environments */
	}
	// An explicit Authorization (e.g. the operator token) wins over the signed-in user's session.
	if (event.locals.session && !headers.has('authorization')) headers.set('authorization', `Bearer ${event.locals.session}`);
	if (body !== undefined) headers.set('content-type', 'application/json');
	const base = (event.platform?.env?.API_URL ?? env.API_URL ?? 'https://api.internal').replace(/\/$/, '');
	const req = new Request(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const binding = event.platform?.env?.API;
	return binding ? binding.fetch(req) : fetch(req);
}

/** JSON call. A 401 on a signed-in page ends the session and sends the user to the login page. */
export async function api<T = any>(event: RequestEvent, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
	const res = await apiRaw(event, method, path, body);
	const text = await res.text();
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	if (res.ok) return json as T;
	const e = json?.error ?? {};
	if (res.status === 401 && event.locals.session && !path.startsWith('/dashboard/v1/login')) {
		event.cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
	throw new ApiFailure(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.param);
}

/** For load functions: turn API failures into SvelteKit error pages. */
export async function load<T = any>(event: RequestEvent, path: string): Promise<T> {
	try {
		return await api<T>(event, 'GET', path);
	} catch (e) {
		if (e instanceof ApiFailure) error(e.status === 403 ? 403 : e.status === 404 ? 404 : 502, e.message);
		throw e;
	}
}

export function setSession(event: RequestEvent, token: string) {
	event.cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: event.url.protocol === 'https:',
		maxAge: 12 * 3600,
	});
}
