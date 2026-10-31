import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(here, '../../db/migrations'));
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						// Test-only keys (never used outside tests).
						DEVICE_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
						WEBHOOK_KEY: 'HxwdGhsYGRYXFBUSExAREg8ODQwLCgkIBwYFBAMCAQA=',
						ADMIN_TOKEN: 'test-admin-token-0123456789abcdef0123',
						MFA_KEY: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=',
						DASHBOARD_URL: 'https://dash.example.com',
						// Tests must not depend on a developer's local .dev.vars.
						PUBLIC_API_URL: '',
					},
				},
			}),
		],
		test: { setupFiles: ['./test/apply-migrations.ts'] },
	};
});
