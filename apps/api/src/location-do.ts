// One Durable Object per location and mode: name = `${merchantId}:${locationId}:${live|test}`.
//
// It runs the pure matching engine one request at a time, keeps the engine state in its own durable
// storage, and writes results to D1 through an outbox (same storage transaction as the state), so
// nothing is lost if D1 or the queue is briefly unavailable. An alarm handles expiry and retries.
import { DurableObject } from 'cloudflare:workers';
import {
	DEFAULT_SETTINGS,
	EngineError,
	LocationEngine,
	randomId,
	randomInt,
	type Changes,
	type EngineEvent,
	type Intent,
	type Settings,
	type Signal,
} from '@autoconfirm/core';
import type { Env } from './env.ts';
import {
	insertAuditStmt,
	insertEventStmt,
	insertIntentStmt,
	updateIntentStmt,
	upsertSignalStmts,
	type AuditEntry,
	type NewIntentExtras,
	type StoredEvent,
} from './db.ts';
import { iso, webhookIntentObject, webhookSignalObject } from './present.ts';

export interface LocationCtx {
	merchantId: string;
	locationId: string;
	livemode: boolean;
	settings: Settings;
}

export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export interface SignalItem {
	app: string;
	amount: number;
	payerShort: string | null;
	reference: string | null;
	notificationKeyHash: string;
	postedAt: number;
}

export interface SignalItemResult {
	ok: boolean;
	signalId?: string;
	status?: Signal['status'];
	repeat?: boolean;
	code?: string;
}

export interface Actor {
	by: string;
	ip: string | null;
}

interface Meta {
	merchantId: string;
	locationId: string;
	livemode: boolean;
	settings: Settings;
}

interface OutboxEntry {
	merchantId: string;
	locationId: string;
	livemode: boolean;
	newIntents: { intent: Intent; extras: NewIntentExtras }[];
	intents: Intent[];
	signals: Signal[];
	events: StoredEvent[];
	audit: AuditEntry[];
	d1Done: boolean;
}

const NONCE_TTL_MS = 10 * 60_000;
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const RETRY_MS = 5_000;

export function locationObjectName(merchantId: string, locationId: string, livemode: boolean): string {
	return `${merchantId}:${locationId}:${livemode ? 'live' : 'test'}`;
}

export class LocationDO extends DurableObject<Env> {
	private engine = new LocationEngine();
	private meta: Meta | undefined;
	private seq = 0;
	private flushChain: Promise<void> = Promise.resolve();
	private flushFailed = false;
	private housekeepAt: number | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(() => this.load());
	}

	private async load() {
		const st = this.ctx.storage;
		this.meta = await st.get<Meta>('meta');
		const intents = [...(await st.list<Intent>({ prefix: 'i:' })).values()];
		const signals = [...(await st.list<Signal>({ prefix: 's:' })).values()];
		this.engine = new LocationEngine(this.meta?.settings ?? DEFAULT_SETTINGS, randomInt, { intents, signals });
		const last = await st.list({ prefix: 'o:', reverse: true, limit: 1 });
		const lastKey = [...last.keys()][0];
		this.seq = lastKey ? Number(lastKey.slice(2)) + 1 : 0;
		for (const prefix of ['n:', 'k:']) {
			for (const v of (await st.list<{ expiresAt: number }>({ prefix })).values()) this.noteHousekeep(v.expiresAt);
		}
	}

	// ---------- RPC methods (called by the API Worker) ----------

	async createIntent(
		lc: LocationCtx,
		input: { id: string; amount: number; orderId: string | null; ttlMs?: number; extras: NewIntentExtras },
	): Promise<Result<{ intent: Intent | null; existingId: string | null }>> {
		await this.prepare(lc);
		const now = Date.now();
		const key = input.extras.idempotencyKey;
		if (key) {
			const prev = await this.ctx.storage.get<{ id: string; expiresAt: number }>(`k:${key}`);
			if (prev && prev.expiresAt > now) return { ok: true, value: { intent: this.engine.getIntent(prev.id) ?? null, existingId: prev.id } };
		}
		const r = this.run(() => this.engine.createIntent({ id: input.id, amount: input.amount, orderId: input.orderId, ttlMs: input.ttlMs }, now));
		if (!r.ok) return r;
		const extraPut: Record<string, unknown> = {};
		if (key) {
			extraPut[`k:${key}`] = { id: input.id, expiresAt: now + IDEMPOTENCY_TTL_MS };
			this.noteHousekeep(now + IDEMPOTENCY_TTL_MS);
		}
		await this.commit(r.value.changes, { newIntents: [{ intent: r.value.intent, extras: input.extras }], extraPut });
		return { ok: true, value: { intent: r.value.intent, existingId: null } };
	}

	/** Records a device request nonce. Returns replayed_nonce if it was seen in the last 10 min. */
	async useNonce(deviceId: string, nonce: string): Promise<Result<true>> {
		const key = `n:${deviceId}:${nonce}`;
		const now = Date.now();
		const prev = await this.ctx.storage.get<{ expiresAt: number }>(key);
		if (prev && prev.expiresAt > now) return { ok: false, code: 'replayed_nonce', message: 'nonce already used' };
		await this.ctx.storage.put(key, { expiresAt: now + NONCE_TTL_MS });
		this.noteHousekeep(now + NONCE_TTL_MS);
		await this.schedule();
		return { ok: true, value: true };
	}

	async ingest(lc: LocationCtx, deviceId: string, clockOffsetMs: number, items: SignalItem[]): Promise<Result<SignalItemResult[]>> {
		await this.prepare(lc);
		const now = Date.now();
		const merged: Changes = { intents: [], signals: [], events: [] };
		const results: SignalItemResult[] = [];
		for (const it of items) {
			const r = this.run(() =>
				this.engine.ingest(
					{
						id: randomId('sig'),
						deviceId,
						app: it.app,
						amount: it.amount,
						payerShort: it.payerShort,
						reference: it.reference,
						notificationKeyHash: it.notificationKeyHash,
						postedAt: it.postedAt,
						clockOffsetMs,
					},
					now,
				),
			);
			if (!r.ok) {
				results.push({ ok: false, code: r.code });
				continue;
			}
			merged.intents.push(...r.value.changes.intents);
			merged.signals.push(...r.value.changes.signals);
			merged.events.push(...r.value.changes.events);
			results.push({ ok: true, signalId: r.value.signal.id, status: r.value.signal.status, repeat: r.value.repeat });
		}
		await this.commit(merged, {});
		return { ok: true, value: results };
	}

	async markPaid(lc: LocationCtx, intentId: string, signalId: string | null, actor: Actor, note: string | null): Promise<Result<Intent>> {
		await this.prepare(lc);
		const now = Date.now();
		const r = this.run(() => this.engine.markPaid(intentId, { by: actor.by, signalId }, now));
		if (!r.ok) return r;
		const action = signalId ? 'signal.assign' : 'intent.mark_paid';
		await this.commit(r.value, { audit: [this.audit(actor, action, intentId, { signal_id: signalId, note }, now)] });
		return { ok: true, value: this.engine.getIntent(intentId)! };
	}

	async rejectSignal(lc: LocationCtx, signalId: string, actor: Actor, note: string | null): Promise<Result<Signal>> {
		await this.prepare(lc);
		const now = Date.now();
		const r = this.run(() => this.engine.rejectSignal(signalId, now, note ?? undefined));
		if (!r.ok) return r;
		await this.commit(r.value, { audit: [this.audit(actor, 'signal.reject', signalId, { note }, now)] });
		return { ok: true, value: this.engine.getSignal(signalId)! };
	}

	async ignoreSignal(lc: LocationCtx, signalId: string, actor: Actor, note: string | null): Promise<Result<Signal>> {
		await this.prepare(lc);
		const now = Date.now();
		const r = this.run(() => this.engine.ignoreSignal(signalId, now, note ?? undefined));
		if (!r.ok) return r;
		await this.commit(r.value, { audit: [this.audit(actor, 'signal.ignore', signalId, { note }, now)] });
		return { ok: true, value: this.engine.getSignal(signalId)! };
	}

	async cancel(lc: LocationCtx, intentId: string, actor: Actor): Promise<Result<Intent>> {
		await this.prepare(lc);
		const now = Date.now();
		const r = this.run(() => this.engine.cancel(intentId, now));
		if (!r.ok) return r;
		await this.commit(r.value, { audit: [this.audit(actor, 'intent.cancel', intentId, {}, now)] });
		return { ok: true, value: this.engine.getIntent(intentId)! };
	}

	async unmarkPaid(lc: LocationCtx, intentId: string, to: 'pending' | 'cancelled', actor: Actor, reason: string): Promise<Result<Intent>> {
		await this.prepare(lc);
		const now = Date.now();
		const r = this.run(() => this.engine.unmarkPaid(intentId, to, now));
		if (!r.ok) return r;
		await this.commit(r.value, { audit: [this.audit(actor, 'intent.unmark_paid', intentId, { reason, to }, now)] });
		return { ok: true, value: this.engine.getIntent(intentId)! };
	}

	async claim(lc: LocationCtx, intentId: string): Promise<Result<Intent>> {
		await this.prepare(lc);
		const r = this.run(() => this.engine.claim(intentId, Date.now()));
		if (!r.ok) return r;
		await this.commit(r.value, {});
		return { ok: true, value: this.engine.getIntent(intentId)! };
	}

	/** Test/debug helper: the engine's current view. */
	async inspect(): Promise<{ intents: Intent[]; signals: Signal[]; outbox: number }> {
		const snap = this.engine.snapshot();
		const outbox = (await this.ctx.storage.list({ prefix: 'o:' })).size;
		return { ...snap, outbox };
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		const t = this.engine.tick(now);
		await this.commit(t.changes, { removedIntentIds: t.removedIntentIds, removedSignalIds: t.removedSignalIds });
		await this.housekeep(now);
		await this.schedule();
	}

	// ---------- internals ----------

	private async prepare(lc: LocationCtx) {
		const m = this.meta;
		const same =
			m &&
			m.merchantId === lc.merchantId &&
			m.locationId === lc.locationId &&
			m.livemode === lc.livemode &&
			JSON.stringify(m.settings) === JSON.stringify(lc.settings);
		if (same) return;
		if (m && (m.merchantId !== lc.merchantId || m.locationId !== lc.locationId || m.livemode !== lc.livemode)) {
			// The object name encodes these, so a mismatch means a routing bug. Refuse rather than mix tenants.
			throw new Error('location object called with a different tenant');
		}
		this.meta = { ...lc };
		this.engine.settings = lc.settings;
		await this.ctx.storage.put('meta', this.meta);
	}

	private run<T>(fn: () => T): Result<T> {
		try {
			return { ok: true, value: fn() };
		} catch (e) {
			if (e instanceof EngineError) return { ok: false, code: e.code, message: e.message };
			throw e;
		}
	}

	private audit(actor: Actor, action: string, objectId: string, detail: Record<string, unknown>, at: number): AuditEntry {
		return { merchantId: this.meta!.merchantId, actor: actor.by, action, objectId, detail, ip: actor.ip, at };
	}

	private toStoredEvent(e: EngineEvent, now: number): StoredEvent | null {
		const meta = this.meta!;
		let object: unknown;
		let objectId: string;
		if ('intentId' in e && e.type.startsWith('payment_intent.')) {
			const i = this.engine.getIntent(e.intentId);
			if (!i) return null;
			const matched = i.matchedSignalId ? this.engine.getSignal(i.matchedSignalId) : null;
			object = webhookIntentObject(i, meta.locationId, meta.livemode, matched);
			objectId = i.id;
		} else {
			const sig = this.engine.getSignal((e as { signalId: string }).signalId);
			if (!sig) return null;
			object = webhookSignalObject(sig, meta.locationId, 'reason' in e ? e.reason : undefined);
			objectId = sig.id;
		}
		const id = randomId('evt');
		const payload = JSON.stringify({ id, object: 'event', type: e.type, created: iso(now), livemode: meta.livemode, data: { object } });
		return { id, merchantId: meta.merchantId, livemode: meta.livemode, type: e.type, objectId, payload, createdAt: now };
	}

	/** Persist engine changes + an outbox entry atomically, then try to flush to D1 / the queue. */
	private async commit(
		changes: Changes,
		opts: {
			newIntents?: { intent: Intent; extras: NewIntentExtras }[];
			audit?: AuditEntry[];
			extraPut?: Record<string, unknown>;
			removedIntentIds?: string[];
			removedSignalIds?: string[];
		},
	) {
		const now = Date.now();
		const put: Record<string, unknown> = { ...(opts.extraPut ?? {}) };
		for (const i of changes.intents) put[`i:${i.id}`] = i;
		for (const s of changes.signals) put[`s:${s.id}`] = s;
		const events = this.meta ? changes.events.map((e) => this.toStoredEvent(e, now)).filter((e): e is StoredEvent => e !== null) : [];
		const newIntents = opts.newIntents ?? [];
		const audit = opts.audit ?? [];
		if (this.meta && (newIntents.length || changes.intents.length || changes.signals.length || events.length || audit.length)) {
			const entry: OutboxEntry = {
				merchantId: this.meta.merchantId,
				locationId: this.meta.locationId,
				livemode: this.meta.livemode,
				newIntents,
				intents: changes.intents,
				signals: changes.signals,
				events,
				audit,
				d1Done: false,
			};
			put[`o:${String(this.seq++).padStart(12, '0')}`] = entry;
		}
		const keys = Object.keys(put);
		for (let k = 0; k < keys.length; k += 128) {
			const chunk: Record<string, unknown> = {};
			for (const key of keys.slice(k, k + 128)) chunk[key] = put[key];
			await this.ctx.storage.put(chunk);
		}
		const del = [...(opts.removedIntentIds ?? []).map((id) => `i:${id}`), ...(opts.removedSignalIds ?? []).map((id) => `s:${id}`)];
		for (let k = 0; k < del.length; k += 128) await this.ctx.storage.delete(del.slice(k, k + 128));
		await this.flush();
		await this.schedule();
	}

	/** Each caller waits for its own entry to be flushed (calls chain one after another). */
	private flush(): Promise<void> {
		this.flushChain = this.flushChain.then(() => this.flushOnce());
		return this.flushChain;
	}

	private async flushOnce(): Promise<void> {
		try {
			const entries = await this.ctx.storage.list<OutboxEntry>({ prefix: 'o:' });
			for (const [key, entry] of entries) {
				if (!entry.d1Done) {
					const db = this.env.DB;
					const stmts: D1PreparedStatement[] = [];
					for (const n of entry.newIntents) stmts.push(insertIntentStmt(db, n.intent, n.extras));
					for (const i of entry.intents) stmts.push(updateIntentStmt(db, entry.merchantId, i));
					for (const s of entry.signals) stmts.push(...upsertSignalStmts(db, entry.merchantId, entry.locationId, entry.livemode, s));
					for (const e of entry.events) stmts.push(insertEventStmt(db, e));
					for (const a of entry.audit) stmts.push(insertAuditStmt(db, a));
					if (stmts.length) await db.batch(stmts); // one transaction
					entry.d1Done = true;
					await this.ctx.storage.put(key, entry);
				}
				if (entry.events.length) {
					await this.env.WEBHOOKS.sendBatch(entry.events.map((e) => ({ body: { eventId: e.id, merchantId: entry.merchantId } })));
				}
				await this.ctx.storage.delete(key);
			}
			this.flushFailed = false;
		} catch (err) {
			this.flushFailed = true;
			console.error('outbox flush failed; will retry', err instanceof Error ? err.message : 'unknown');
		}
	}

	private noteHousekeep(at: number) {
		this.housekeepAt = this.housekeepAt === null ? at : Math.min(this.housekeepAt, at);
	}

	private async housekeep(now: number) {
		if (this.housekeepAt === null || this.housekeepAt > now) return;
		this.housekeepAt = null;
		for (const prefix of ['n:', 'k:']) {
			const rows = await this.ctx.storage.list<{ expiresAt: number }>({ prefix });
			const expired: string[] = [];
			for (const [k, v] of rows) {
				if (v.expiresAt <= now) expired.push(k);
				else this.noteHousekeep(v.expiresAt);
			}
			for (let k = 0; k < expired.length; k += 128) await this.ctx.storage.delete(expired.slice(k, k + 128));
		}
	}

	private async schedule() {
		const now = Date.now();
		const times = [this.engine.nextWakeAt(), this.flushFailed ? now + RETRY_MS : null, this.housekeepAt].filter(
			(t): t is number => t !== null,
		);
		if (times.length === 0) return;
		const next = Math.max(Math.min(...times), now + 1);
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > next || current < now) await this.ctx.storage.setAlarm(next);
	}
}
