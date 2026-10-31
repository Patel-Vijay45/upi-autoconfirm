import type { LayoutServerLoad } from './$types';
import { load as get } from '$lib/server/api.ts';

export const load: LayoutServerLoad = async (event) => {
	if (!event.locals.session) return { me: null, mode: event.locals.mode };
	const me = await get(event, '/dashboard/v1/me');
	return { me, mode: event.locals.mode };
};
