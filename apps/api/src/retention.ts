// Daily data clean-up (privacy policy "How long we keep data"). Runs from the 5-minute cron once a day.
// Personal details are removed, not the records merchants need for their accounts: a payment stays,
// but the payer name, UTR and customer contact details are blanked after the periods below.
import type { Env } from './env.ts';

const DAY = 86_400_000;

export const RETENTION_DAYS = {
	/** Payer short name and UTR on signals; also duplicate/ignored signals are deleted. */
	signalDetails: 90,
	/** Customer name/phone a merchant's site attached to a payment. */
	customerDetails: 365,
	/** Activity log entries (their IP address after 90 days). */
	auditLog: 365,
	auditIp: 90,
	/** Webhook events and delivery logs (resend works within this window). */
	events: 30,
	parseFailures: 7,
} as const;

/** Is this cron run the daily clean-up slot? 22:15 UTC = 03:45 IST (the cron fires every 5 min). */
export function isRetentionSlot(scheduledTime: number): boolean {
	const d = new Date(scheduledTime);
	return d.getUTCHours() === 22 && d.getUTCMinutes() >= 15 && d.getUTCMinutes() < 20;
}

export async function runRetention(env: Env, now = Date.now()): Promise<void> {
	const before = (days: number) => now - days * DAY;
	const R = RETENTION_DAYS;
	await env.DB.batch([
		env.DB.prepare('UPDATE signals SET payer_name = NULL, reference = NULL WHERE received_at < ? AND (payer_name IS NOT NULL OR reference IS NOT NULL)').bind(before(R.signalDetails)),
		env.DB.prepare("DELETE FROM signals WHERE received_at < ? AND status IN ('duplicate', 'ignored')").bind(before(R.signalDetails)),
		env.DB.prepare('UPDATE payment_intents SET customer_name = NULL, customer_phone = NULL WHERE created_at < ? AND (customer_name IS NOT NULL OR customer_phone IS NOT NULL)').bind(before(R.customerDetails)),
		env.DB.prepare('UPDATE audit_log SET ip = NULL WHERE at < ? AND ip IS NOT NULL').bind(before(R.auditIp)),
		env.DB.prepare('DELETE FROM audit_log WHERE at < ?').bind(before(R.auditLog)),
		env.DB.prepare('DELETE FROM events WHERE created_at < ?').bind(before(R.events)),
		env.DB.prepare('DELETE FROM webhook_deliveries WHERE created_at < ?').bind(before(R.events)),
		env.DB.prepare('DELETE FROM parse_failures WHERE received_at < ?').bind(before(R.parseFailures)),
		// Short-lived security records.
		env.DB.prepare('DELETE FROM idempotency WHERE created_at < ?').bind(before(2)),
		env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
		env.DB.prepare('DELETE FROM user_invites WHERE expires_at < ?').bind(before(7)),
		env.DB.prepare('DELETE FROM login_throttle WHERE window_start < ?').bind(before(1)),
		env.DB.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').bind(now),
	]);
}
