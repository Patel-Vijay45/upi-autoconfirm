// Alerts on this browser: the Counters & phones card posts here (JSON); we pass it to the API as the signed-in user.
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { api, ApiFailure } from '$lib/server/api.ts';

export const POST: RequestHandler = async (event) => {
	// JSON posts aren't covered by SvelteKit's form CSRF check, so check the origin here.
	if (event.request.headers.get('origin') !== event.url.origin) error(403, 'cross-site request');
	const body = (await event.request.json().catch(() => null)) as { action?: string; subscription?: unknown; endpoint?: string } | null;
	const call = (path: string, payload?: unknown) =>
		api(event, 'POST', path, payload).then(
			(r) => json(r),
			(e) => (e instanceof ApiFailure ? json({ error: e.message }, { status: e.status }) : Promise.reject(e)),
		);
	if (body?.action === 'subscribe') return call('/v1/push_subscriptions', body.subscription);
	if (body?.action === 'unsubscribe') return call('/v1/push_subscriptions/delete', { endpoint: body.endpoint ?? '' });
	if (body?.action === 'test') return call('/v1/push_subscriptions/test');
	error(400, 'unknown action');
};
