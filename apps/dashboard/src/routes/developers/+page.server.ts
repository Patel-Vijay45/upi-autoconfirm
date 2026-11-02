import type { Actions, PageServerLoad } from './$types';
import { api, load as get } from '$lib/server/api.ts';
import { form, run } from '$lib/server/actions.ts';

export const load: PageServerLoad = async (event) => {
	const [keys, endpoints, deliveries, events, projects] = await Promise.all([
		get(event, '/v1/api_keys'),
		get(event, '/v1/webhook_endpoints'),
		get(event, '/v1/webhook_deliveries?limit=20'),
		get(event, '/v1/events?limit=20'),
		get(event, '/v1/projects'),
	]);
	return { keys: keys.data, endpoints: endpoints.data, deliveries: deliveries.data, events: events.data, projects: projects.data as { id: string; name: string; active: boolean }[] };
};

export const actions: Actions = {
	createKey: async (event) => {
		const f = await form(event);
		return run(async () => {
			const k = await api(event, 'POST', '/v1/api_keys', { kind: f.kind === 'publishable' ? 'publishable' : 'secret', ...(f.project_id ? { project_id: f.project_id } : {}) });
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
			const project = String(fd.get('project_id') ?? '');
			const ep = await api(event, 'POST', '/v1/webhook_endpoints', { url: String(fd.get('url') ?? '').trim(), events: events.length ? events : ['*'], ...(project ? { project_id: project } : {}) });
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
	addProject: async (event) => {
		const f = await form(event);
		return run(async () => {
			const p = await api(event, 'POST', '/v1/projects', { name: (f.name ?? '').trim() });
			return { done: `Project "${p.name}" added. Create its API keys and webhook below.` };
		});
	},
	toggleProject: async (event) => {
		const f = await form(event);
		return run(async () => {
			await api(event, 'POST', `/v1/projects/${encodeURIComponent(f.id!)}`, { active: f.active === 'true' });
			return { done: f.active === 'true' ? 'Project resumed.' : "Project paused. Its keys stop working until you resume it." };
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
