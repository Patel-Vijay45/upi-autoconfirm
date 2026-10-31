// Operator page: create a shop (merchant) and its owner's setup link, or invite a user to a shop.
// The operator token is sent straight to the API for this one request; it is never stored or echoed back.
import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import { apiRaw } from '$lib/server/api.ts';
import { form } from '$lib/server/actions.ts';

async function operator(event: Parameters<Actions[string]>[0], token: string, path: string, body: unknown) {
	const res = await apiRaw(event, 'POST', path, body, { authorization: `Bearer ${token}` });
	const json = (await res.json().catch(() => ({}))) as any;
	if (res.ok) return { ok: true as const, json };
	const message =
		res.status === 401 ? 'Wrong operator token.' : res.status === 404 && path === '/admin/v1/merchants' ? 'The operator API is off (ADMIN_TOKEN is not set on the API).' : (json?.error?.message ?? `Failed (${res.status})`);
	return { ok: false as const, status: res.status, message };
}

export const actions: Actions = {
	createShop: async (event) => {
		const f = await form(event);
		const name = (f.name ?? '').trim();
		const email = (f.email ?? '').trim();
		if (!f.token || !name || !email) return fail(400, { action: 'createShop', error: 'Fill in all fields.', name, email });
		const m = await operator(event, f.token, '/admin/v1/merchants', { name });
		if (!m.ok) return fail(m.status >= 400 && m.status < 500 ? m.status : 400, { action: 'createShop', error: m.message, name, email });
		const inv = await operator(event, f.token, `/admin/v1/merchants/${m.json.merchant.id}/invites`, { email, role: 'owner' });
		if (!inv.ok) return fail(400, { action: 'createShop', error: `Shop created (${m.json.merchant.id}), but the owner invite failed: ${inv.message}`, name, email });
		return {
			action: 'createShop',
			shop: { id: m.json.merchant.id as string, name: m.json.merchant.name as string },
			keys: {
				secret_test: m.json.secret_key_test as string,
				publishable_test: m.json.publishable_key_test as string,
				secret_live: m.json.secret_key_live as string,
				publishable_live: m.json.publishable_key_live as string,
			},
			setupUrl: `${event.url.origin}/setup/${inv.json.token}`,
			email,
		};
	},
	invite: async (event) => {
		const f = await form(event);
		const merchant = (f.merchant ?? '').trim();
		const email = (f.email ?? '').trim();
		const role = ['owner', 'admin', 'staff', 'developer'].includes(f.role ?? '') ? f.role : 'staff';
		if (!f.token || !merchant || !email) return fail(400, { action: 'invite', error: 'Fill in all fields.', merchant, email });
		const inv = await operator(event, f.token, `/admin/v1/merchants/${encodeURIComponent(merchant)}/invites`, { email, role });
		if (!inv.ok) return fail(inv.status >= 400 && inv.status < 500 ? inv.status : 400, { action: 'invite', error: inv.message, merchant, email });
		return { action: 'invite', setupUrl: `${event.url.origin}/setup/${inv.json.token}`, email, role };
	},
};
