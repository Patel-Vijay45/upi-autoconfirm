import { redirect, type Handle } from '@sveltejs/kit';
import { MODE_COOKIE, SESSION_COOKIE } from '$lib/server/api.ts';

const PUBLIC = (path: string) => path === '/login' || path.startsWith('/setup/');

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.session = event.cookies.get(SESSION_COOKIE) ?? null;
	event.locals.mode = event.cookies.get(MODE_COOKIE) === 'test' ? 'test' : 'live';
	if (!event.locals.session && !PUBLIC(event.url.pathname)) redirect(303, '/login');
	const res = await resolve(event);
	res.headers.set('x-frame-options', 'DENY');
	res.headers.set('x-content-type-options', 'nosniff');
	res.headers.set('referrer-policy', 'same-origin');
	if (!res.headers.has('cache-control')) res.headers.set('cache-control', 'private, no-store');
	return res;
};
