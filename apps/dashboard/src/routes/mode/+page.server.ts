import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { MODE_COOKIE } from '$lib/server/api.ts';

export const load: PageServerLoad = () => redirect(303, '/');

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const mode = (await request.formData()).get('mode') === 'test' ? 'test' : 'live';
		cookies.set(MODE_COOKIE, mode, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 365 * 86400 });
		const back = request.headers.get('referer');
		redirect(303, back && new URL(back).origin === url.origin ? new URL(back).pathname : '/');
	},
};
