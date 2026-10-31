import type { Actions, PageServerLoad } from './$types';
import { api, load as get } from '$lib/server/api.ts';
import { form, run } from '$lib/server/actions.ts';

export const load: PageServerLoad = async (event) => {
	const [settings, users, audit] = await Promise.all([get(event, '/v1/settings'), get(event, '/v1/users'), get(event, '/v1/audit_log?limit=30')]);
	return { settings, users: users.data, audit: audit.data };
};

const rupeesToPaise = (s: string): number | null => {
	const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim().replace(/[₹,]/g, ''));
	return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};

export const actions: Actions = {
	save: async (event) => {
		const f = await form(event);
		const limit = (f.auto_confirm_max ?? '').trim();
		const max = limit === '' ? null : rupeesToPaise(limit);
		if (limit !== '' && max === null) return { error: 'Auto-confirm limit must be an amount in rupees, like 2000 or 2000.50.' };
		return run(async () => {
			await api(event, 'POST', '/v1/settings', {
				auto_confirm_max: max,
				intent_ttl: Number(f.intent_ttl) * 60,
				max_intent_ttl: Number(f.max_intent_ttl) * 60,
			});
			return { done: 'Settings saved.' };
		});
	},
	invite: async (event) => {
		const f = await form(event);
		return run(async () => {
			const inv = await api(event, 'POST', '/v1/users/invites', { email: (f.email ?? '').trim(), role: f.role });
			return { inviteUrl: `${event.url.origin}/setup/${inv.token}`, inviteEmail: inv.email as string };
		});
	},
	deactivate: async (event) => {
		const f = await form(event);
		return run(async () => {
			await api(event, 'POST', `/v1/users/${encodeURIComponent(f.id!)}/deactivate`);
			return { done: 'User deactivated and logged out.' };
		});
	},
};
