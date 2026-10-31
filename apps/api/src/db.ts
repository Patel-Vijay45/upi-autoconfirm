// D1 access. Every tenant query is scoped by merchant_id (CLAUDE.md "Tenancy").
import type { Intent, Signal } from '@autoconfirm/core';

export interface MerchantRow {
	id: string;
	name: string;
	status: 'active' | 'suspended' | 'closed';
	settings: string;
}

export interface LocationRow {
	id: string;
	merchant_id: string;
	name: string;
	upi_vpa: string;
	upi_payee_name: string;
	active: number;
	created_at: number;
}

export interface DeviceRow {
	id: string;
	merchant_id: string;
	location_id: string;
	livemode: number;
	label: string;
	secret_enc: string;
	status: 'pending' | 'online' | 'offline' | 'revoked';
	clock_offset_ms: number;
	last_heartbeat_at: number | null;
	last_signal_at: number | null;
	app_version: string | null;
	created_at: number;
}

export interface IntentRow {
	id: string;
	merchant_id: string;
	location_id: string;
	livemode: number;
	status: Intent['status'];
	amount: number;
	unique_amount: number;
	order_id: string | null;
	description: string | null;
	customer_name: string | null;
	customer_phone: string | null;
	return_url: string | null;
	metadata: string;
	idempotency_key: string | null;
	created_at: number;
	expires_at: number;
	customer_claimed_at: number | null;
	paid_at: number | null;
	paid_source: 'auto' | 'manual' | null;
	paid_by_user: string | null;
	matched_signal_id: string | null;
	late: number;
	amount_mismatch: number;
	cancelled_at: number | null;
	reserved_until: number | null;
	updated_at: number;
}

export interface SignalRow {
	id: string;
	merchant_id: string;
	location_id: string;
	device_id: string;
	livemode: number;
	app: string;
	amount: number;
	payer_name: string | null;
	reference: string | null;
	posted_at: number;
	paid_time: number;
	received_at: number;
	fingerprint: string;
	status: Signal['status'];
	payment_intent_id: string | null;
	duplicate_of: string | null;
	note: string | null;
}

/** Fields of a new intent that only D1 keeps (the engine doesn't need them). */
export interface NewIntentExtras {
	merchantId: string;
	locationId: string;
	livemode: boolean;
	description: string | null;
	customerName: string | null;
	customerPhone: string | null;
	returnUrl: string | null;
	metadata: Record<string, string>;
	idempotencyKey: string | null;
}

export interface AuditEntry {
	merchantId: string;
	actor: string;
	action: string;
	objectId: string | null;
	detail: Record<string, unknown>;
	ip: string | null;
	at: number;
}

export interface StoredEvent {
	id: string;
	merchantId: string;
	livemode: boolean;
	type: string;
	objectId: string;
	/** Full event JSON, exactly as delivered to webhooks. */
	payload: string;
	createdAt: number;
}

// ---------- reads ----------

export const getMerchant = (db: D1Database, id: string) =>
	db.prepare('SELECT id, name, status, settings FROM merchants WHERE id = ?').bind(id).first<MerchantRow>();

export const getLocation = (db: D1Database, merchantId: string, id: string) =>
	db.prepare('SELECT * FROM locations WHERE id = ? AND merchant_id = ?').bind(id, merchantId).first<LocationRow>();

export async function listLocations(db: D1Database, merchantId: string): Promise<LocationRow[]> {
	const r = await db.prepare('SELECT * FROM locations WHERE merchant_id = ? ORDER BY created_at').bind(merchantId).all<LocationRow>();
	return r.results;
}

export const getIntent = (db: D1Database, merchantId: string, id: string) =>
	db.prepare('SELECT * FROM payment_intents WHERE id = ? AND merchant_id = ?').bind(id, merchantId).first<IntentRow>();

export const getSignal = (db: D1Database, merchantId: string, id: string) =>
	db.prepare('SELECT * FROM signals WHERE id = ? AND merchant_id = ?').bind(id, merchantId).first<SignalRow>();

export const getDevice = (db: D1Database, id: string) => db.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first<DeviceRow>();

// ---------- writes used by the location Durable Object (outbox flush) ----------

export function insertIntentStmt(db: D1Database, i: Intent, x: NewIntentExtras): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR IGNORE INTO payment_intents
			 (id, merchant_id, location_id, livemode, status, amount, unique_amount, order_id, description,
			  customer_name, customer_phone, return_url, metadata, idempotency_key, created_at, expires_at, late,
			  amount_mismatch, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
		)
		.bind(
			i.id,
			x.merchantId,
			x.locationId,
			x.livemode ? 1 : 0,
			i.status,
			i.amount,
			i.uniqueAmount,
			i.orderId,
			x.description,
			x.customerName,
			x.customerPhone,
			x.returnUrl,
			JSON.stringify(x.metadata),
			x.idempotencyKey,
			i.createdAt,
			i.expiresAt,
			i.updatedAt,
		);
}

export function updateIntentStmt(db: D1Database, merchantId: string, i: Intent): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE payment_intents SET status = ?, customer_claimed_at = ?, paid_at = ?, paid_source = ?, paid_by_user = ?,
			 matched_signal_id = ?, late = ?, amount_mismatch = ?, cancelled_at = ?, reserved_until = ?, updated_at = ?
			 WHERE id = ? AND merchant_id = ?`,
		)
		.bind(
			i.status,
			i.customerClaimedAt,
			i.paidAt,
			i.paidSource,
			i.paidBy,
			i.matchedSignalId,
			i.late ? 1 : 0,
			i.amountMismatch ? 1 : 0,
			i.cancelledAt,
			i.reservedUntil,
			i.updatedAt,
			i.id,
			merchantId,
		);
}

export function upsertSignalStmts(db: D1Database, merchantId: string, locationId: string, livemode: boolean, s: Signal): D1PreparedStatement[] {
	return [
		// OR IGNORE also covers the (location_id, fingerprint) unique key.
		db
			.prepare(
				`INSERT OR IGNORE INTO signals
				 (id, merchant_id, location_id, device_id, livemode, app, amount, payer_name, reference, posted_at, paid_time,
				  received_at, fingerprint, status, payment_intent_id, duplicate_of, note)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				s.id,
				merchantId,
				locationId,
				s.deviceId,
				livemode ? 1 : 0,
				s.app,
				s.amount,
				s.payerShort,
				s.reference,
				s.postedAt,
				s.paidTime,
				s.receivedAt,
				s.fingerprint,
				s.status,
				s.intentId,
				s.duplicateOf,
				s.note,
			),
		db
			.prepare('UPDATE signals SET status = ?, payment_intent_id = ?, duplicate_of = ?, note = ? WHERE id = ? AND merchant_id = ?')
			.bind(s.status, s.intentId, s.duplicateOf, s.note, s.id, merchantId),
	];
}

export function insertEventStmt(db: D1Database, e: StoredEvent): D1PreparedStatement {
	return db
		.prepare('INSERT OR IGNORE INTO events (id, merchant_id, livemode, type, object_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.bind(e.id, e.merchantId, e.livemode ? 1 : 0, e.type, e.objectId, e.payload, e.createdAt);
}

export function insertAuditStmt(db: D1Database, a: AuditEntry): D1PreparedStatement {
	return db
		.prepare('INSERT INTO audit_log (merchant_id, actor, action, object_id, detail, ip, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.bind(a.merchantId, a.actor, a.action, a.objectId, JSON.stringify(a.detail), a.ip, a.at);
}
