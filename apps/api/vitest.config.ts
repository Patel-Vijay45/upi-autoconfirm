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
						CHECKOUT_BASE_URL: 'https://pay.example.com',
						// Test-only VAPID key (push alerts). Real keys are created by the deploy script.
						VAPID_PRIVATE_KEY: '{"kty":"EC","crv":"P-256","x":"mDLOtFmO6KlYUlZQ9DCE1X_EJ9w7bvqDvLeD9uONTZc","y":"Y98Ehk8SFKAhy-QtC_zVTbRTiNJy6Jow1EaHGVsp2co","d":"YpwyUTPdpkLPrPbEZb-E5FTwSqfH55AhJM9d3Gr671g"}',
					},
				},
			}),
		],
		test: { setupFiles: ['./test/apply-migrations.ts'] },
	};
});
