import type { Actions, PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { qrSvg } from '@autoconfirm/core';
import { api, load as get } from '$lib/server/api.ts';
import { run } from '$lib/server/actions.ts';

export const load: PageServerLoad = async (event) => {
	const locations = await get(event, '/v1/locations');
	const loc = locations.data.find((l: { id: string }) => l.id === event.params.id);
	if (!loc) error(404, 'Counter not found');
	return { loc };
};

export const actions: Actions = {
	default: async (event) =>
		run(async () => {
			const pc = await api(event, 'POST', `/v1/locations/${encodeURIComponent(event.params.id)}/pairing_codes`);
			return { link: pc.pairing_link as string, expires_at: pc.expires_at as string, qr: qrSvg(pc.pairing_link, { label: 'Phone pairing QR code' }) };
		}),
};
