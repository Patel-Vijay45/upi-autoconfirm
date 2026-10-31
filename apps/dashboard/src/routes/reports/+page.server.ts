import type { PageServerLoad } from './$types';
import { load as get } from '$lib/server/api.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const load: PageServerLoad = async (event) => {
	const from = event.url.searchParams.get('from') ?? '';
	const to = event.url.searchParams.get('to') ?? '';
	const q = new URLSearchParams();
	if (DATE.test(from)) q.set('from', from);
	if (DATE.test(to)) q.set('to', to);
	const report = await get(event, `/v1/reports/summary?${q}`);
	return { report, q: q.toString() };
};
