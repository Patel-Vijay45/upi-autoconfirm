import type { Actions, PageServerLoad } from './$types';
import { api, load as get } from '$lib/server/api.ts';
import { form, run } from '$lib/server/actions.ts';

export const load: PageServerLoad = async (event) => {
	const tab = event.url.searchParams.get('tab') === 'other' ? 'other' : 'check';
	const open = event.url.searchParams.get('open');
	// "Needs a look": review, ambiguous, and unmatched payments near an order. "Other payments": likely walk-ins.
	const [review, unmatched, ambiguous, other] = await Promise.all([
		get(event, '/v1/signals?status=review&limit=30'),
		get(event, '/v1/signals?status=unmatched&walk_in=false&limit=30'),
		get(event, '/v1/signals?status=ambiguous&limit=30'),
		get(event, '/v1/signals?status=unmatched&walk_in=true&limit=50'),
	]);
	const check = [...review.data, ...unmatched.data, ...ambiguous.data].slice(0, 30);
	// Each "needs a look" signal with its suggested orders (closest amount and time at the same counter).
	// Other payments load suggestions only for the one being matched (keeps sub-requests low).
	const detailIds = tab === 'check' ? check.map((s: { id: string }) => s.id) : open ? [open] : [];
	const details = new Map<string, unknown>(
		(await Promise.all(detailIds.map((id: string) => get(event, `/v1/signals/${encodeURIComponent(id)}`)))).map((d: { id: string }) => [d.id, d]),
	);
	return {
		tab,
		open,
		checkCount: check.length,
		otherCount: other.data.length,
		otherMore: other.has_more as boolean,
		signals: tab === 'check' ? check.map((s: { id: string }) => details.get(s.id) ?? s) : other.data.map((s: { id: string }) => details.get(s.id) ?? s),
	};
};

const act = (fn: (event: Parameters<Actions[string]>[0], f: Record<string, string>) => Promise<unknown>, done: string) => async (event: Parameters<Actions[string]>[0]) => {
	const f = await form(event);
	return run(async () => {
		await fn(event, f);
		return { done };
	});
};

export const actions: Actions = {
	assign: act((e, f) => api(e, 'POST', `/v1/signals/${encodeURIComponent(f.signal!)}/assign`, { payment_intent: f.intent }), 'Payment matched to the order.'),
	reject: act((e, f) => api(e, 'POST', `/v1/signals/${encodeURIComponent(f.signal!)}/reject`, f.reason ? { reason: f.reason } : {}), 'Moved to unmatched.'),
	ignore: act((e, f) => api(e, 'POST', `/v1/signals/${encodeURIComponent(f.signal!)}/ignore`, f.reason ? { reason: f.reason } : {}), 'Ignored.'),
};
