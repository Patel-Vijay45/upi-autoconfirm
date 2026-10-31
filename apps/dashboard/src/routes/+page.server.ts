import type { PageServerLoad } from './$types';
import { load as get } from '$lib/server/api.ts';

const STATUSES = ['pending', 'paid', 'expired', 'cancelled'];

export const load: PageServerLoad = async (event) => {
	const status = event.url.searchParams.get('status') ?? '';
	const location = event.url.searchParams.get('location_id') ?? '';
	const after = event.url.searchParams.get('starting_after') ?? '';
	const q = new URLSearchParams({ limit: '25' });
	if (STATUSES.includes(status)) q.set('status', status);
	if (location) q.set('location_id', location);
	if (after) q.set('starting_after', after);
	const [intents, locations] = await Promise.all([get(event, `/v1/payment_intents?${q}`), get(event, '/v1/locations')]);
	return { intents, locations: locations.data, status, location };
};
