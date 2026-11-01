import type { Actions, PageServerLoad } from './$types';
import { api, load as get } from '$lib/server/api.ts';
import { form, run } from '$lib/server/actions.ts';

export const load: PageServerLoad = async (event) => {
	const [locations, devices, push] = await Promise.all([get(event, '/v1/locations'), get(event, '/v1/devices'), get(event, '/v1/push/config')]);
	return { locations: locations.data, devices: devices.data, push: push as { enabled: boolean; public_key: string | null } };
};

export const actions: Actions = {
	create: async (event) => {
		const f = await form(event);
		return run(async () => {
			await api(event, 'POST', '/v1/locations', { name: f.name, upi_vpa: (f.upi_vpa ?? '').trim(), upi_payee_name: f.upi_payee_name });
			return { done: 'Counter added. Now add a phone to it.' };
		});
	},
	update: async (event) => {
		const f = await form(event);
		return run(async () => {
			await api(event, 'POST', `/v1/locations/${encodeURIComponent(f.id!)}`, { ...(f.name ? { name: f.name } : {}), ...(f.active ? { active: f.active === 'true' } : {}) });
			return { done: 'Saved.' };
		});
	},
	revoke: async (event) => {
		const f = await form(event);
		return run(async () => {
			await api(event, 'POST', `/v1/devices/${encodeURIComponent(f.id!)}/revoke`);
			return { done: 'Phone removed. It can no longer confirm payments.' };
		});
	},
};
