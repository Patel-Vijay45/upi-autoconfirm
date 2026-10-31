import { fail, isRedirect, type RequestEvent } from '@sveltejs/kit';
import { ApiFailure } from './api.ts';

/** Run a form action; API errors come back to the form as { error } instead of crashing the page. */
export async function run<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail<{ error: string; field?: string }>>> {
	try {
		return await fn();
	} catch (e) {
		if (isRedirect(e)) throw e;
		if (e instanceof ApiFailure) return fail(e.status >= 400 && e.status < 500 ? e.status : 400, { error: e.message, field: e.param });
		throw e;
	}
}

export async function form(event: RequestEvent): Promise<Record<string, string>> {
	const fd = await event.request.formData();
	const out: Record<string, string> = {};
	for (const [k, v] of fd) if (typeof v === 'string') out[k] = v;
	return out;
}
