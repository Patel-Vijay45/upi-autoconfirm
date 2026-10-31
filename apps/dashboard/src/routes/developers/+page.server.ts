import type { Actions, PageServerLoad } from './$types';
import { api, load as get } from '$lib/server/api.ts';
import { form, run } from '$lib/server/actions.ts';

export const load: PageServerLoad = async (event) => {
	const [keys, endpoints, deliveries, events] = await Promise.all([
		get(event, '/v1/api_keys'),
		get(event, '/v1/webhook_endpoints'),
		get(event, '/v1/webhook_deliveries?limit=20'),
		get(event, '/v1/events?limit=20'),
	]);
	return { keys: keys.data, endpoints: endpoints.data, deliveries: deliveries.data, events: events.data };
};

export const actions: Actions = {
	createKey: async (event) => {
		const f = await form(event);
		return run(async () => {
			const k = await api(event, 'POST', '/v1/api_keys', { kind: f.kind === 'publishable' ? 'publishable' : 'secret' });
			return { newKey: k.key as string };
		});
	},
	revokeKey: async (event) => {
		const f = await form(event);
		return run(async () => {
			await api(event, 'POST', `/v1/api_keys/${encodeURIComponent(f.id!)}/revoke`);
			return { done: 'Key revoked. Requests using it now fail.' };
		});
	},
	addEndpoint: async (event) => {
		const fd = await event.request.formData();
		const events = fd.getAll('events').map(String);
		return run(async () => {
			const ep = await api(event, 'POST', '/v1/webhook_endpoints', { url: String(fd.get('url') ?? '').trim(), events: events.length ? events : ['*'] });
			return { newSecret: ep.secret as string };
		});
	},
	toggle: async (event) => {
		const f = await form(event);
		return run(async () => {
			await api(event, 'POST', `/v1/webhook_endpoints/${encodeURIComponent(f.id!)}/${f.enable === 'true' ? 'enable' : 'disable'}`);
			return { done: 'Saved.' };
		});
	},
	resend: async (event) => {
		const f = await form(event);
		return run(async () => {
			await api(event, 'POST', `/v1/events/${encodeURIComponent(f.id!)}/resend`);
			return { done: 'Event queued for delivery again.' };
		});
	},
};
