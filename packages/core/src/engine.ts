// The matching engine for ONE location (see docs/MATCHING.md).
//
// Pure and synchronous: no I/O, no clock, no global randomness. The caller (the location's
// Durable Object) passes `now`, persists the returned changes, and runs one call at a time.
//
// Safety rules enforced here:
// - A signal pays an intent only when exactly one open intent at this location has that exact amount,
//   the payment was sent after the intent was created, and the amount is within auto_confirm_max.
// - Open intents never share an amount; a closed intent's amount stays reserved for reuse_cooldown.
// - A signal links to at most one intent, and an intent is paid by at most one signal.

import { isPaise } from './money.ts';
import { randomInt } from './ids.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type IntentStatus = 'pending' | 'paid' | 'expired' | 'cancelled';
export type SignalStatus = 'matched' | 'unmatched' | 'ambiguous' | 'review' | 'ignored' | 'duplicate';

export interface Settings {
	/** `add_paise`: unique = amount + random offset in [1, maxOffset]. `none`: unique = amount (one open intent per amount). */
	offsetMode: 'add_paise' | 'none';
	maxOffset: number;
	intentTtlMs: number;
	maxIntentTtlMs: number;
	graceMs: number;
	reuseCooldownMs: number;
	/** Above this unique amount (paise), a match goes to `review` for a staff tap. null = no limit. */
	autoConfirmMax: number | null;
	minAmount: number;
	maxAmount: number;
	maxSignalAgeMs: number;
	dedupeWindowMs: number;
	/** Allowance for phone clock error when checking "paid after the intent was created". */
	clockAllowanceMs: number;
	undoWindowMs: number;
	/** How long resolved signals are kept in the engine for dedupe. */
	signalRetentionMs: number;
	/** How long unresolved inbox signals (unmatched / ambiguous / review) stay assignable. */
	inboxRetentionMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
	offsetMode: 'add_paise',
	maxOffset: 99,
	intentTtlMs: 15 * MIN,
	maxIntentTtlMs: 60 * MIN,
	graceMs: 30 * MIN,
	reuseCooldownMs: 60 * MIN,
	autoConfirmMax: null,
	minAmount: 100,
	maxAmount: 10_000_000,
	maxSignalAgeMs: DAY,
	dedupeWindowMs: 2 * MIN,
	clockAllowanceMs: 2 * MIN,
	undoWindowMs: DAY,
	signalRetentionMs: 2 * DAY,
	inboxRetentionMs: 30 * DAY,
};

export interface Intent {
	id: string;
	status: IntentStatus;
	amount: number;
	uniqueAmount: number;
	orderId: string | null;
	createdAt: number;
	expiresAt: number;
	paidAt: number | null;
	paidSource: 'auto' | 'manual' | null;
	paidBy: string | null;
	matchedSignalId: string | null;
	late: boolean;
	amountMismatch: boolean;
	cancelledAt: number | null;
	customerClaimedAt: number | null;
	/** Amount stays reserved until this time once the intent is closed. null while pending. */
	reservedUntil: number | null;
	/** payment_intent.expired is sent once the grace window is over. */
	expiryNotified: boolean;
	updatedAt: number;
}

export interface Signal {
	id: string;
	deviceId: string;
	app: string;
	amount: number;
	payerShort: string | null;
	reference: string | null;
	notificationKeyHash: string;
	postedAt: number;
	/** posted_at corrected by the device clock offset, never later than receivedAt. */
	paidTime: number;
	receivedAt: number;
	fingerprint: string;
	status: SignalStatus;
	/** Matched intent, or the suggested intent while in review. */
	intentId: string | null;
	duplicateOf: string | null;
	note: string | null;
	updatedAt: number;
}

export type UnmatchedReason = 'no_match' | 'ambiguous' | 'rejected' | 'unpaid' | 'intent_closed';

export type EngineEvent =
	| { type: 'payment_intent.paid'; intentId: string }
	| { type: 'payment_intent.expired'; intentId: string }
	| { type: 'payment_intent.cancelled'; intentId: string }
	| { type: 'payment_intent.unpaid'; intentId: string }
	| { type: 'signal.unmatched'; signalId: string; reason: UnmatchedReason }
	| { type: 'signal.review_required'; signalId: string; intentId: string };

export interface Changes {
	intents: Intent[];
	signals: Signal[];
	events: EngineEvent[];
}

export type EngineErrorCode =
	| 'amount_too_small'
	| 'amount_too_large'
	| 'invalid_amount'
	| 'invalid_ttl'
	| 'slots_exhausted'
	| 'duplicate_id'
	| 'not_found'
	| 'invalid_state'
	| 'undo_window_passed'
	| 'amount_in_use';

export class EngineError extends Error {
	constructor(
		readonly code: EngineErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'EngineError';
	}
}

export interface CreateIntentInput {
	id: string;
	amount: number;
	orderId?: string | null;
	ttlMs?: number;
}

export interface SignalInput {
	id: string;
	deviceId: string;
	app: string;
	amount: number;
	payerShort?: string | null;
	reference?: string | null;
	notificationKeyHash: string;
	postedAt: number;
	/** server time − phone time, from the device's last heartbeat. */
	clockOffsetMs: number;
}

export interface IngestResult {
	signal: Signal;
	/** true when this exact upload was already received (device retry). Nothing changed. */
	repeat: boolean;
	changes: Changes;
}

export interface EngineState {
	intents: Intent[];
	signals: Signal[];
}

class Tx {
	private intents = new Map<string, Intent>();
	private signals = new Map<string, Signal>();
	readonly events: EngineEvent[] = [];
	intent(i: Intent, now: number) {
		i.updatedAt = now;
		this.intents.set(i.id, i);
	}
	signal(s: Signal, now: number) {
		s.updatedAt = now;
		this.signals.set(s.id, s);
	}
	emit(e: EngineEvent) {
		this.events.push(e);
	}
	done(): Changes {
		// Return copies so callers can't mutate engine state by accident.
		return {
			intents: [...this.intents.values()].map((i) => ({ ...i })),
			signals: [...this.signals.values()].map((s) => ({ ...s })),
			events: this.events,
		};
	}
}

function normPayer(p: string | null): string {
	return (p ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export class LocationEngine {
	private intents = new Map<string, Intent>();
	private signals = new Map<string, Signal>();
	private fingerprints = new Map<string, string>(); // fingerprint -> signal id

	constructor(
		public settings: Settings = DEFAULT_SETTINGS,
		private readonly rand: (maxExclusive: number) => number = randomInt,
		state?: EngineState,
	) {
		for (const i of state?.intents ?? []) this.intents.set(i.id, { ...i });
		for (const s of state?.signals ?? []) {
			this.signals.set(s.id, { ...s });
			this.fingerprints.set(s.fingerprint, s.id);
		}
	}

	// ---------- reads ----------

	getIntent(id: string): Intent | undefined {
		const i = this.intents.get(id);
		return i && { ...i };
	}

	getSignal(id: string): Signal | undefined {
		const s = this.signals.get(id);
		return s && { ...s };
	}

	snapshot(): EngineState {
		return {
			intents: [...this.intents.values()].map((i) => ({ ...i })),
			signals: [...this.signals.values()].map((s) => ({ ...s })),
		};
	}

	/** The next time `tick` has work to do (expiry, expiry event, prune). null if nothing is scheduled. */
	nextWakeAt(): number | null {
		let next = Infinity;
		for (const i of this.intents.values()) {
			if (i.status === 'pending') next = Math.min(next, i.expiresAt);
			else if (i.status === 'expired' && !i.expiryNotified) next = Math.min(next, i.expiresAt + this.settings.graceMs);
			else next = Math.min(next, this.intentPruneAt(i));
		}
		for (const s of this.signals.values()) next = Math.min(next, this.signalPruneAt(s));
		return Number.isFinite(next) ? next : null;
	}

	/** Is this unique amount unavailable for a new intent right now? */
	isReserved(uniqueAmount: number, now: number): boolean {
		for (const i of this.intents.values()) {
			if (i.uniqueAmount === uniqueAmount && this.reserves(i, now)) return true;
		}
		return false;
	}

	// ---------- commands ----------

	/** Expire due intents, send expiry events after grace. Call before anything else (the methods below do). */
	tick(now: number): { changes: Changes; removedIntentIds: string[]; removedSignalIds: string[] } {
		const tx = new Tx();
		this.sweep(now, tx);
		const removed = this.prune(now);
		return { changes: tx.done(), ...removed };
	}

	createIntent(input: CreateIntentInput, now: number): { intent: Intent; changes: Changes } {
		const s = this.settings;
		if (!isPaise(input.amount)) throw new EngineError('invalid_amount', 'amount must be integer paise');
		if (input.amount < s.minAmount) throw new EngineError('amount_too_small', `amount must be at least ${s.minAmount} paise`);
		if (input.amount > s.maxAmount) throw new EngineError('amount_too_large', `amount must be at most ${s.maxAmount} paise`);
		const ttl = input.ttlMs ?? s.intentTtlMs;
		if (!Number.isInteger(ttl) || ttl < 2 * MIN || ttl > s.maxIntentTtlMs) {
			throw new EngineError('invalid_ttl', `expiry must be between 2 min and ${s.maxIntentTtlMs / MIN} min`);
		}
		if (this.intents.has(input.id)) throw new EngineError('duplicate_id', 'intent id already exists');

		const tx = new Tx();
		this.sweep(now, tx);

		const used = new Set<number>();
		for (const i of this.intents.values()) if (this.reserves(i, now)) used.add(i.uniqueAmount);
		const free: number[] = [];
		if (s.offsetMode === 'none') {
			if (!used.has(input.amount)) free.push(input.amount);
		} else {
			for (let off = 1; off <= s.maxOffset; off++) if (!used.has(input.amount + off)) free.push(input.amount + off);
		}
		if (free.length === 0) throw new EngineError('slots_exhausted', 'all unique amounts for this base amount are in use');
		const uniqueAmount = free[this.rand(free.length)]!;

		const intent: Intent = {
			id: input.id,
			status: 'pending',
			amount: input.amount,
			uniqueAmount,
			orderId: input.orderId ?? null,
			createdAt: now,
			expiresAt: now + ttl,
			paidAt: null,
			paidSource: null,
			paidBy: null,
			matchedSignalId: null,
			late: false,
			amountMismatch: false,
			cancelledAt: null,
			customerClaimedAt: null,
			reservedUntil: null,
			expiryNotified: false,
			updatedAt: now,
		};
		this.intents.set(intent.id, intent);
		tx.intent(intent, now);
		return { intent: { ...intent }, changes: tx.done() };
	}

	ingest(input: SignalInput, now: number): IngestResult {
		const s = this.settings;
		if (!isPaise(input.amount) || input.amount === 0) throw new EngineError('invalid_amount', 'signal amount must be positive integer paise');

		const fingerprint = `${input.deviceId}|${input.notificationKeyHash}|${input.amount}|${input.postedAt}`;
		const seen = this.fingerprints.get(fingerprint);
		if (seen) {
			const prev = this.signals.get(seen);
			if (prev) return { signal: { ...prev }, repeat: true, changes: { intents: [], signals: [], events: [] } };
		}
		if (this.signals.has(input.id)) throw new EngineError('duplicate_id', 'signal id already exists');

		const tx = new Tx();
		this.sweep(now, tx);

		const paidTime = Math.min(input.postedAt + input.clockOffsetMs, now);
		const signal: Signal = {
			id: input.id,
			deviceId: input.deviceId,
			app: input.app,
			amount: input.amount,
			payerShort: input.payerShort ?? null,
			reference: input.reference ?? null,
			notificationKeyHash: input.notificationKeyHash,
			postedAt: input.postedAt,
			paidTime,
			receivedAt: now,
			fingerprint,
			status: 'unmatched',
			intentId: null,
			duplicateOf: null,
			note: null,
			updatedAt: now,
		};
		this.signals.set(signal.id, signal);
		this.fingerprints.set(fingerprint, signal.id);

		// 1. Too old to trust for matching.
		if (now - paidTime > s.maxSignalAgeMs) {
			signal.status = 'ignored';
			signal.note = 'too_old';
			tx.signal(signal, now);
			return { signal: { ...signal }, repeat: false, changes: tx.done() };
		}

		// 2. Same payment reported twice (backup phone, or an updated notification).
		const original = this.findDuplicateOf(signal);
		if (original) {
			signal.status = 'duplicate';
			signal.duplicateOf = original.id;
			tx.signal(signal, now);
			return { signal: { ...signal }, repeat: false, changes: tx.done() };
		}

		// 3. Candidates: same amount, open (or expired within grace), created before the money was sent.
		let candidates = [...this.intents.values()].filter(
			(i) =>
				i.uniqueAmount === signal.amount &&
				(i.status === 'pending' || (i.status === 'expired' && now - i.expiresAt <= s.graceMs)) &&
				i.createdAt - s.clockAllowanceMs <= paidTime,
		);
		if (signal.reference && this.intents.has(signal.reference)) {
			candidates = candidates.filter((i) => i.id === signal.reference);
		}
		// An intent that already has a signal waiting for review can't take a second one automatically.
		const inReview = candidates.length === 1 && this.reviewSignalFor(candidates[0]!.id) !== undefined;

		if (candidates.length === 1 && !inReview) {
			const intent = candidates[0]!;
			if (s.autoConfirmMax === null || intent.uniqueAmount <= s.autoConfirmMax) {
				this.pay(intent, signal, 'auto', null, now, tx);
			} else {
				signal.status = 'review';
				signal.intentId = intent.id;
				tx.signal(signal, now);
				tx.emit({ type: 'signal.review_required', signalId: signal.id, intentId: intent.id });
			}
		} else if (candidates.length === 0) {
			signal.status = 'unmatched';
			tx.signal(signal, now);
			tx.emit({ type: 'signal.unmatched', signalId: signal.id, reason: 'no_match' });
		} else {
			signal.status = 'ambiguous';
			tx.signal(signal, now);
			tx.emit({ type: 'signal.unmatched', signalId: signal.id, reason: 'ambiguous' });
		}
		return { signal: { ...signal }, repeat: false, changes: tx.done() };
	}

	/** Manual "mark paid" (optionally linking an inbox signal). Also the Confirm step for a review signal. */
	markPaid(intentId: string, opts: { by: string; signalId?: string | null }, now: number): Changes {
		const tx = new Tx();
		this.sweep(now, tx);
		const intent = this.mustIntent(intentId);
		if (intent.status !== 'pending' && intent.status !== 'expired') {
			throw new EngineError('invalid_state', `intent is ${intent.status}`);
		}
		let signal: Signal | null = null;
		if (opts.signalId) {
			signal = this.mustSignal(opts.signalId);
			if (!['unmatched', 'ambiguous', 'review'].includes(signal.status)) {
				throw new EngineError('invalid_state', `signal is ${signal.status}`);
			}
		}
		this.pay(intent, signal, 'manual', opts.by, now, tx);
		return tx.done();
	}

	assignSignal(signalId: string, intentId: string, by: string, now: number): Changes {
		return this.markPaid(intentId, { by, signalId }, now);
	}

	rejectSignal(signalId: string, now: number, note?: string): Changes {
		const tx = new Tx();
		this.sweep(now, tx);
		const signal = this.mustSignal(signalId);
		if (signal.status !== 'review') throw new EngineError('invalid_state', `signal is ${signal.status}`);
		signal.status = 'unmatched';
		signal.intentId = null;
		signal.note = note ?? 'rejected';
		tx.signal(signal, now);
		tx.emit({ type: 'signal.unmatched', signalId, reason: 'rejected' });
		return tx.done();
	}

	ignoreSignal(signalId: string, now: number, note?: string): Changes {
		const tx = new Tx();
		this.sweep(now, tx);
		const signal = this.mustSignal(signalId);
		if (!['unmatched', 'ambiguous', 'review'].includes(signal.status)) {
			throw new EngineError('invalid_state', `signal is ${signal.status}`);
		}
		signal.status = 'ignored';
		signal.intentId = null;
		signal.note = note ?? null;
		tx.signal(signal, now);
		return tx.done();
	}

	cancel(intentId: string, now: number): Changes {
		const tx = new Tx();
		this.sweep(now, tx);
		const intent = this.mustIntent(intentId);
		if (intent.status !== 'pending' && intent.status !== 'expired') {
			throw new EngineError('invalid_state', `intent is ${intent.status}`);
		}
		intent.status = 'cancelled';
		intent.cancelledAt = now;
		intent.reservedUntil = Math.max(intent.reservedUntil ?? 0, now + this.settings.reuseCooldownMs);
		tx.intent(intent, now);
		this.releaseReviews(intent.id, now, tx);
		tx.emit({ type: 'payment_intent.cancelled', intentId });
		return tx.done();
	}

	/** Undo a paid status within the undo window. The linked signal goes back to the inbox. */
	unmarkPaid(intentId: string, to: 'pending' | 'cancelled', now: number): Changes {
		const s = this.settings;
		const tx = new Tx();
		this.sweep(now, tx);
		const intent = this.mustIntent(intentId);
		if (intent.status !== 'paid' || intent.paidAt === null) throw new EngineError('invalid_state', `intent is ${intent.status}`);
		if (now - intent.paidAt > s.undoWindowMs) throw new EngineError('undo_window_passed', 'paid status can only be undone within 24 h');

		const reopening = to === 'pending';
		if (reopening) {
			const clash = [...this.intents.values()].some(
				(o) =>
					o.id !== intent.id &&
					o.uniqueAmount === intent.uniqueAmount &&
					(o.status === 'pending' || (o.status === 'expired' && now - o.expiresAt <= s.graceMs)),
			);
			if (clash) throw new EngineError('amount_in_use', 'this amount is now used by another open intent; cancel instead');
		}

		if (intent.matchedSignalId) {
			const sig = this.signals.get(intent.matchedSignalId);
			if (sig && sig.status === 'matched' && sig.intentId === intent.id) {
				sig.status = 'unmatched';
				sig.intentId = null;
				sig.note = 'unpaid';
				tx.signal(sig, now);
				tx.emit({ type: 'signal.unmatched', signalId: sig.id, reason: 'unpaid' });
			}
		}
		intent.paidAt = null;
		intent.paidSource = null;
		intent.paidBy = null;
		intent.matchedSignalId = null;
		intent.late = false;
		intent.amountMismatch = false;
		if (reopening) {
			if (now < intent.expiresAt) {
				intent.status = 'pending';
				intent.reservedUntil = null;
			} else {
				intent.status = 'expired';
				intent.expiryNotified = false;
				intent.reservedUntil = Math.max(intent.expiresAt + s.graceMs + s.reuseCooldownMs, now + s.reuseCooldownMs);
			}
		} else {
			intent.status = 'cancelled';
			intent.cancelledAt = now;
			intent.reservedUntil = Math.max(intent.reservedUntil ?? 0, now + s.reuseCooldownMs);
		}
		tx.intent(intent, now);
		tx.emit({ type: 'payment_intent.unpaid', intentId });
		if (!reopening) tx.emit({ type: 'payment_intent.cancelled', intentId });
		return tx.done();
	}

	/** Customer tapped "I have paid". Never changes the status. */
	claim(intentId: string, now: number): Changes {
		const tx = new Tx();
		this.sweep(now, tx);
		const intent = this.mustIntent(intentId);
		if ((intent.status === 'pending' || intent.status === 'expired') && intent.customerClaimedAt === null) {
			intent.customerClaimedAt = now;
			tx.intent(intent, now);
		}
		return tx.done();
	}

	// ---------- internals ----------

	private reserves(i: Intent, now: number): boolean {
		return i.status === 'pending' || (i.reservedUntil !== null && i.reservedUntil > now);
	}

	private pay(intent: Intent, signal: Signal | null, source: 'auto' | 'manual', by: string | null, now: number, tx: Tx) {
		const wasExpired = intent.status === 'expired';
		intent.status = 'paid';
		intent.paidAt = now;
		intent.paidSource = source;
		intent.paidBy = by;
		intent.matchedSignalId = signal?.id ?? null;
		intent.late = wasExpired;
		intent.amountMismatch = signal !== null && signal.amount !== intent.uniqueAmount;
		intent.reservedUntil = Math.max(intent.reservedUntil ?? 0, now + this.settings.reuseCooldownMs);
		tx.intent(intent, now);
		if (signal) {
			signal.status = 'matched';
			signal.intentId = intent.id;
			tx.signal(signal, now);
		}
		this.releaseReviews(intent.id, now, tx, signal?.id);
		tx.emit({ type: 'payment_intent.paid', intentId: intent.id });
	}

	/** Review signals waiting on an intent that just closed go back to the inbox. */
	private releaseReviews(intentId: string, now: number, tx: Tx, exceptSignalId?: string) {
		for (const sig of this.signals.values()) {
			if (sig.status === 'review' && sig.intentId === intentId && sig.id !== exceptSignalId) {
				sig.status = 'unmatched';
				sig.intentId = null;
				sig.note = 'intent_closed';
				tx.signal(sig, now);
				tx.emit({ type: 'signal.unmatched', signalId: sig.id, reason: 'intent_closed' });
			}
		}
	}

	private reviewSignalFor(intentId: string): Signal | undefined {
		for (const sig of this.signals.values()) if (sig.status === 'review' && sig.intentId === intentId) return sig;
		return undefined;
	}

	/**
	 * Is this signal another report of a payment we already have? Copies come from:
	 *  - another phone at the same counter (backup phone),
	 *  - the same notification updated (same phone, same notification key),
	 *  - another channel on the same phone (the payment app's alert and the bank's SMS for one payment).
	 * Copies pair one-to-one per (phone, channel), so a customer who really pays twice still shows up.
	 */
	private findDuplicateOf(sig: Signal): Signal | undefined {
		const w = this.settings.dedupeWindowMs;
		let best: Signal | undefined;
		for (const o of this.signals.values()) {
			if (o.id === sig.id || o.status === 'duplicate') continue;
			if (o.amount !== sig.amount) continue;
			if (o.reference && sig.reference && o.reference !== sig.reference) continue;
			if (Math.abs(o.paidTime - sig.paidTime) > w) continue;
			const otherDevice = o.deviceId !== sig.deviceId;
			const otherChannel = o.app !== sig.app;
			const sameNotification = !otherDevice && !otherChannel && o.notificationKeyHash === sig.notificationKeyHash;
			if (!otherDevice && !otherChannel && !sameNotification) continue; // same phone + same app + new notification = a second real payment
			// Payer names must agree. Across channels one side may have no name (bank SMS often doesn't show it).
			const a = normPayer(o.payerShort);
			const b = normPayer(sig.payerShort);
			if (otherChannel ? a !== '' && b !== '' && a !== b : a !== b) continue;
			// Pair one-to-one: each original takes at most one copy per (phone, channel).
			let taken = false;
			for (const d of this.signals.values()) {
				if (d.duplicateOf === o.id && d.deviceId === sig.deviceId && d.app === sig.app) {
					taken = true;
					break;
				}
			}
			if (taken) continue;
			if (!best || o.paidTime < best.paidTime) best = o;
		}
		return best;
	}

	private sweep(now: number, tx: Tx) {
		const s = this.settings;
		for (const i of this.intents.values()) {
			if (i.status === 'pending' && i.expiresAt <= now) {
				i.status = 'expired';
				i.reservedUntil = i.expiresAt + s.graceMs + s.reuseCooldownMs;
				tx.intent(i, now);
			}
			if (i.status === 'expired' && !i.expiryNotified && now >= i.expiresAt + s.graceMs) {
				i.expiryNotified = true;
				tx.intent(i, now);
				tx.emit({ type: 'payment_intent.expired', intentId: i.id });
			}
		}
	}

	private intentPruneAt(i: Intent): number {
		if (i.status === 'pending') return Infinity;
		if (i.status === 'expired' && !i.expiryNotified) return Infinity;
		let t = i.reservedUntil ?? 0;
		if (i.status === 'paid' && i.paidAt !== null) t = Math.max(t, i.paidAt + this.settings.undoWindowMs);
		if (i.status === 'expired') t = Math.max(t, i.expiresAt + this.settings.graceMs);
		return t;
	}

	private signalPruneAt(sig: Signal): number {
		const open = sig.status === 'unmatched' || sig.status === 'ambiguous' || sig.status === 'review';
		return sig.receivedAt + (open ? this.settings.inboxRetentionMs : this.settings.signalRetentionMs);
	}

	private prune(now: number): { removedIntentIds: string[]; removedSignalIds: string[] } {
		const removedIntentIds: string[] = [];
		const removedSignalIds: string[] = [];
		for (const i of this.intents.values()) {
			if (this.intentPruneAt(i) <= now && !this.reviewSignalFor(i.id)) {
				this.intents.delete(i.id);
				removedIntentIds.push(i.id);
			}
		}
		for (const sig of this.signals.values()) {
			if (this.signalPruneAt(sig) <= now) {
				this.signals.delete(sig.id);
				this.fingerprints.delete(sig.fingerprint);
				removedSignalIds.push(sig.id);
			}
		}
		return { removedIntentIds, removedSignalIds };
	}

	private mustIntent(id: string): Intent {
		const i = this.intents.get(id);
		if (!i) throw new EngineError('not_found', 'intent not found');
		return i;
	}

	private mustSignal(id: string): Signal {
		const s = this.signals.get(id);
		if (!s) throw new EngineError('not_found', 'signal not found');
		return s;
	}
}
