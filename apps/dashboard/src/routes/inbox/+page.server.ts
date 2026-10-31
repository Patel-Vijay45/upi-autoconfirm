import type { Actions, PageServerLoad } from './$types';
import { api, load as get } from '$lib/server/api.ts';
import { form, run } from '$lib/server/actions.ts';

export const load: PageServerLoad = async (event) => {
	const lists = await Promise.all(['review', 'unmatched', 'ambiguous'].map((s) => get(event, `/v1/signals?status=${s}&limit=30`)));
	const all = lists.flatMap((l) => l.data).slice(0, 40);
	// Each signal with its suggested orders (closest amount and time at the same counter).
	const signals = await Promise.all(all.map((s: { id: string }) => get(event, `/v1/signals/${s.id}`)));
	return { signals };
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
