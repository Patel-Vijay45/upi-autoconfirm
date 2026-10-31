import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { apiRaw, SESSION_COOKIE } from '$lib/server/api.ts';

export const load: PageServerLoad = () => redirect(303, '/');

export const actions: Actions = {
	default: async (event) => {
		if (event.locals.session) await apiRaw(event, 'POST', '/dashboard/v1/logout').catch(() => undefined);
		event.cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	},
};
