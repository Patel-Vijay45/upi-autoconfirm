// API representations (see api/openapi.yaml). Public status never includes personal data.
import { buildUpiLinks, formatPaise, qrSvg, type Intent, type Signal } from '@autoconfirm/core';
import type { CheckoutView } from '@autoconfirm/checkout/view';
import type { IntentRow, LocationRow, NewIntentExtras, SignalRow } from './db.ts';

export const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** Pending intents past expires_at show as expired even before the sweep has written it. */
function effectiveStatus(row: Pick<IntentRow, 'status' | 'expires_at'>, now: number): IntentRow['status'] {
	return row.status === 'pending' && row.expires_at <= now ? 'expired' : row.status;
}

export function rowFromEngine(i: Intent, x: NewIntentExtras): IntentRow {
	return {
		id: i.id,
		merchant_id: x.merchantId,
		location_id: x.locationId,
		livemode: x.livemode ? 1 : 0,
		status: i.status,
		amount: i.amount,
		unique_amount: i.uniqueAmount,
		order_id: i.orderId,
		description: x.description,
		customer_name: x.customerName,
		customer_phone: x.customerPhone,
		return_url: x.returnUrl,
		metadata: JSON.stringify(x.metadata),
		idempotency_key: x.idempotencyKey,
		created_at: i.createdAt,
		expires_at: i.expiresAt,
		customer_claimed_at: i.customerClaimedAt,
		paid_at: i.paidAt,
		paid_source: i.paidSource,
		paid_by_user: i.paidBy,
		matched_signal_id: i.matchedSignalId,
		late: i.late ? 1 : 0,
		amount_mismatch: i.amountMismatch ? 1 : 0,
		cancelled_at: i.cancelledAt,
		reserved_until: i.reservedUntil,
		updated_at: i.updatedAt,
	};
}

export function presentIntent(
	row: IntentRow,
	location: LocationRow,
	checkoutBase: string,
	now: number,
	matchedSignal?: SignalRow | null,
	opts: { qr?: boolean } = {},
) {
	const status = effectiveStatus(row, now);
	const upi = buildUpiLinks({ vpa: location.upi_vpa, payeeName: location.upi_payee_name }, row.unique_amount, row.id, row.order_id ?? undefined);
	let metadata: Record<string, string> = {};
	try {
		metadata = JSON.parse(row.metadata) as Record<string, string>;
	} catch {
		metadata = {};
	}
	return {
		id: row.id,
		object: 'payment_intent' as const,
		status,
		amount: row.amount,
		unique_amount: row.unique_amount,
		display_amount: formatPaise(row.unique_amount),
		currency: 'INR' as const,
		order_id: row.order_id,
		description: row.description,
		location_id: row.location_id,
		customer: row.customer_name || row.customer_phone ? { name: row.customer_name, phone: row.customer_phone } : null,
		created: iso(row.created_at),
		expires_at: iso(row.expires_at),
		paid_at: iso(row.paid_at),
		customer_claimed_at: iso(row.customer_claimed_at),
		livemode: row.livemode === 1,
		checkout_url: `${checkoutBase.replace(/\/$/, '')}/p/${row.id}`,
		return_url: row.return_url,
		// qr_svg is left out of lists to keep them small.
		upi: opts.qr === false ? upi : { ...upi, qr_svg: qrSvg(upi.uri) },
		match:
			row.status === 'paid'
				? {
						source: row.paid_source,
						signal_id: row.matched_signal_id,
						app: matchedSignal?.app ?? null,
						late: row.late === 1,
						amount_mismatch: row.amount_mismatch === 1,
						received_amount: matchedSignal?.amount ?? null,
					}
				: null,
		metadata,
	};
}

export function presentPublicStatus(row: IntentRow, now: number) {
	return {
		status: effectiveStatus(row, now),
		display_amount: formatPaise(row.unique_amount),
		expires_at: iso(row.expires_at),
		paid_at: iso(row.paid_at),
	};
}

export function presentSignal(row: SignalRow) {
	return {
		id: row.id,
		object: 'signal' as const,
		status: row.status,
		location_id: row.location_id,
		device_id: row.device_id,
		app: row.app,
		amount: row.amount,
		display_amount: formatPaise(row.amount),
		payer_name: row.payer_name,
		reference: row.reference,
		posted_at: iso(row.posted_at),
		paid_time: iso(row.paid_time),
		received_at: iso(row.received_at),
		payment_intent: row.payment_intent_id,
		duplicate_of: row.duplicate_of,
		note: row.note,
	};
}

/** The object inside webhook events (what the location DO knows; merchants re-fetch for the rest). */
export function webhookIntentObject(i: Intent, locationId: string, livemode: boolean, matched?: Signal | null) {
	return {
		id: i.id,
		object: 'payment_intent' as const,
		status: i.status,
		amount: i.amount,
		unique_amount: i.uniqueAmount,
		display_amount: formatPaise(i.uniqueAmount),
		order_id: i.orderId,
		location_id: locationId,
		livemode,
		expires_at: iso(i.expiresAt),
		paid_at: iso(i.paidAt),
		match:
			i.status === 'paid'
				? {
						source: i.paidSource,
						signal_id: i.matchedSignalId,
						app: matched?.app ?? null,
						late: i.late,
						amount_mismatch: i.amountMismatch,
						received_amount: matched?.amount ?? null,
					}
				: null,
	};
}

export function webhookSignalObject(s: Signal, locationId: string, reason?: string) {
	return {
		id: s.id,
		object: 'signal' as const,
		status: s.status,
		location_id: locationId,
		app: s.app,
		amount: s.amount,
		display_amount: formatPaise(s.amount),
		payer_name: s.payerShort,
		reference: s.reference,
		received_at: iso(s.receivedAt),
		payment_intent: s.intentId,
		reason: reason ?? null,
	};
}

/** What the hosted page and checkout.js show. Built from the intent and its location; no customer data. */
export function checkoutView(row: IntentRow, location: LocationRow, now: number): CheckoutView {
	const upi = buildUpiLinks({ vpa: location.upi_vpa, payeeName: location.upi_payee_name }, row.unique_amount, row.id, row.order_id ?? undefined);
	return {
		id: row.id,
		status: effectiveStatus(row, now),
		amount: row.amount,
		unique_amount: row.unique_amount,
		display_amount: formatPaise(row.unique_amount),
		payee_name: location.upi_payee_name,
		order_id: row.order_id,
		expires_at: iso(row.expires_at)!,
		paid_at: iso(row.paid_at),
		return_url: row.return_url,
		upi,
		qr_svg: qrSvg(upi.uri),
	};
}
