import type { RequestHandler } from './$types';
import { apiRaw } from '$lib/server/api.ts';

export const GET: RequestHandler = async (event) => {
	const q = new URLSearchParams();
	for (const k of ['from', 'to']) {
		const v = event.url.searchParams.get(k);
		if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) q.set(k, v);
	}
	const res = await apiRaw(event, 'GET', `/v1/reports/payments.csv?${q}`);
	return new Response(res.body, {
		status: res.status,
		headers: {
			'content-type': res.headers.get('content-type') ?? 'text/csv',
			'content-disposition': res.headers.get('content-disposition') ?? 'attachment; filename="payments.csv"',
			'cache-control': 'no-store',
		},
	});
};
