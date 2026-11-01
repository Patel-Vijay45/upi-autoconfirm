import { app } from './app.ts';
import type { Env, WebhookMessage } from './env.ts';
import { handleWebhookBatch } from './webhooks.ts';
import { checkOfflinePhones } from './alerts.ts';

export { LocationDO } from './location-do.ts';
export { PasswordDO } from './password-do.ts';

export default {
	fetch: app.fetch,
	async queue(batch: MessageBatch<WebhookMessage>, env: Env): Promise<void> {
		await handleWebhookBatch(batch, env);
	},
	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await checkOfflinePhones(env);
	},
} satisfies ExportedHandler<Env, WebhookMessage>;
