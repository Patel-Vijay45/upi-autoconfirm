import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { api, ApiFailure, setSession } from '$lib/server/api.ts';
import { form } from '$lib/server/actions.ts';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.session) redirect(303, '/');
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		const f = await form(event);
		const body = { email: f.email ?? '', password: f.password ?? '', ...(f.otp ? { otp: f.otp.replace(/\s/g, '') } : {}) };
		try {
			const r = await api(event, 'POST', '/dashboard/v1/login', body);
			setSession(event, r.token);
		} catch (e) {
			if (e instanceof ApiFailure) return fail(e.status === 429 ? 429 : 400, { email: body.email, error: e.message, needOtp: e.code === 'otp_required' || e.code === 'invalid_otp' });
			throw e;
		}
		redirect(303, '/');
	},
};
