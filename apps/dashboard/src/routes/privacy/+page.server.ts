import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';

// Public page (no login): Google Play links here from the store listing and from inside the app.
export const load: PageServerLoad = async (event) => {
	const vars = (event.platform?.env ?? {}) as Record<string, string | undefined>;
	const pick = (k: string) => (vars[k] ?? env[k] ?? '').trim();
	return { operator: pick('OPERATOR_NAME'), email: pick('SUPPORT_EMAIL'), updated: '1 November 2026' };
};
