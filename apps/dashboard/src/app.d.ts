declare global {
	namespace App {
		interface Locals {
			session: string | null;
			mode: 'test' | 'live';
		}
		interface Platform {
			env?: {
				API?: { fetch: (request: Request) => Promise<Response> };
				API_URL?: string;
			};
		}
	}
}
export {};
