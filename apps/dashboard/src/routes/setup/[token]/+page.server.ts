import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { api, ApiFailure, setSession } from '$lib/server/api.ts';
import { form } from '$lib/server/actions.ts';

export const load: PageServerLoad = async (event) => {
	try {
		return { invite: await api(event, 'GET', `/dashboard/v1/invites/${encodeURIComponent(event.params.token)}`) };
	} catch (e) {
		if (e instanceof ApiFailure) error(404, 'This setup link is invalid, expired or already used. Ask your shop owner for a new one.');
		throw e;
	}
};

export const actions: Actions = {
	default: async (event) => {
		const f = await form(event);
		if ((f.password ?? '') !== (f.confirm ?? '')) return fail(400, { error: 'The two passwords do not match.' });
		try {
			const r = await api(event, 'POST', `/dashboard/v1/invites/${encodeURIComponent(event.params.token)}`, {
				password: f.password ?? '',
				...(f.otp ? { otp: f.otp.replace(/\s/g, '') } : {}),
			});
			setSession(event, r.token);
		} catch (e) {
			if (e instanceof ApiFailure) return fail(400, { error: e.message });
			throw e;
		}
		redirect(303, '/');
	},
};
