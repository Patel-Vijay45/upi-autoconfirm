import type { LocationDO } from './location-do.ts';

export interface Env {
	DB: D1Database;
	LOCATION: DurableObjectNamespace<LocationDO>;
	WEBHOOKS: Queue<WebhookMessage>;
	RULES: KVNamespace;
	/** base64, 32 bytes: encrypts device secrets at rest. */
	DEVICE_KEY: string;
	/** base64, 32 bytes: encrypts webhook endpoint secrets at rest. */
	WEBHOOK_KEY: string;
	/** base64, 32 bytes: encrypts dashboard users' TOTP secrets at rest. */
	MFA_KEY: string;
	/** Dashboard base URL, used to build setup links for invited users (optional). */
	DASHBOARD_URL?: string;
	/** Operator token for /admin/v1 (creating merchants). Unset = admin API disabled. */
	ADMIN_TOKEN?: string;
	CHECKOUT_BASE_URL: string;
	/** Public base URL of this API, put in pairing links. Defaults to the request origin. */
	PUBLIC_API_URL?: string;
}

/** Without endpointId the consumer fans out to each subscribed endpoint. */
export interface WebhookMessage {
	eventId: string;
	merchantId: string;
	endpointId?: string;
}
