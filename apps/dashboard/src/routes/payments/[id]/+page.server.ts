import type { Actions, PageServerLoad } from './$types';
import { api, load as get } from '$lib/server/api.ts';
import { form, run } from '$lib/server/actions.ts';

export const load: PageServerLoad = async (event) => {
	const pi = await get(event, `/v1/payment_intents/${encodeURIComponent(event.params.id)}`);
	return { pi };
};

const path = (id: string, action: string) => `/v1/payment_intents/${encodeURIComponent(id)}/${action}`;

export const actions: Actions = {
	markPaid: async (event) => {
		const f = await form(event);
		return run(async () => {
			await api(event, 'POST', path(event.params.id, 'mark_paid'), f.note ? { note: f.note } : {});
			return { done: 'Marked as paid.' };
		});
	},
	cancel: async (event) =>
		run(async () => {
			await api(event, 'POST', path(event.params.id, 'cancel'));
			return { done: 'Payment request cancelled.' };
		}),
	unmark: async (event) => {
		const f = await form(event);
		return run(async () => {
			await api(event, 'POST', path(event.params.id, 'unmark_paid'), { reason: f.reason ?? '', status: f.status === 'cancelled' ? 'cancelled' : 'pending' });
			return { done: 'Paid status undone.' };
		});
	},
};
