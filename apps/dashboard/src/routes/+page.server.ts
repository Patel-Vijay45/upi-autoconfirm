import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { apiRaw, load as get } from '$lib/server/api.ts';
import { form } from '$lib/server/actions.ts';
import { parseRupees } from '$lib/format.ts';

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
	// A fresh Idempotency-Key per form render: a double tap can't create two payments.
	return { intents, locations: locations.data, status, location, newKey: crypto.randomUUID() };
};

export const actions: Actions = {
	/** "New payment": staff type an amount and show the customer the QR. */
	create: async (event) => {
		const f = await form(event);
		const amount = parseRupees(f.amount ?? '');
		if (amount === null || amount < 100) return fail(400, { error: 'Enter an amount of at least ₹1, like 250 or 930.50.', amount: f.amount ?? '', note: f.note ?? '' });
		const body: Record<string, unknown> = { amount };
		if (f.note?.trim()) body.order_id = f.note.trim().slice(0, 64);
		if (f.location_id) body.location_id = f.location_id;
		const res = await apiRaw(event, 'POST', '/v1/payment_intents', body, { 'idempotency-key': `dash-${f.key ?? crypto.randomUUID()}` });
		const json = (await res.json().catch(() => ({}))) as any;
		if (!res.ok) return fail(res.status >= 400 && res.status < 500 ? res.status : 400, { error: json?.error?.message ?? 'Could not create the payment.', amount: f.amount ?? '', note: f.note ?? '' });
		redirect(303, `/payments/${json.id}`);
	},
};
