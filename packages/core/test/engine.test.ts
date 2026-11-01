import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EngineError, LocationEngine, type Settings, type SignalInput } from '../src/engine.ts';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

/** Deterministic "random": always picks index k (default first free). */
const pick = (k = 0) => (n: number) => Math.min(k, n - 1);

function engine(settings: Partial<Settings> = {}, rand = pick()) {
	return new LocationEngine({ ...DEFAULT_SETTINGS, ...settings }, rand);
}

let seq = 0;
function sig(amount: number, over: Partial<SignalInput> = {}, at = T0): SignalInput {
	seq++;
	return {
		id: `sig_${seq}`,
		deviceId: 'dev_a',
		app: 'phonepe_business',
		amount,
		payerShort: 'Ramesh P',
		reference: null,
		notificationKeyHash: `key_${seq}`,
		postedAt: at,
		clockOffsetMs: 0,
		...over,
	};
}

function code(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (e) {
		if (e instanceof EngineError) return e.code;
		throw e;
	}
	return undefined;
}

describe('allocation', () => {
	it('adds a paise offset in [1, 99] and never repeats an open amount', () => {
		const e = engine({}, (n) => n - 1); // always the highest free offset
		const seen = new Set<number>();
		for (let k = 0; k < 99; k++) {
			const { intent } = e.createIntent({ id: `pi_${k}`, amount: 93000 }, T0);
			expect(intent.uniqueAmount).toBeGreaterThanOrEqual(93001);
			expect(intent.uniqueAmount).toBeLessThanOrEqual(93099);
			expect(seen.has(intent.uniqueAmount)).toBe(false);
			seen.add(intent.uniqueAmount);
		}
		expect(code(() => e.createIntent({ id: 'pi_x', amount: 93000 }, T0))).toBe('slots_exhausted');
		// A different base amount still works.
		expect(e.createIntent({ id: 'pi_y', amount: 50000 }, T0).intent.uniqueAmount).toBe(50099);
	});

	it('picks among free offsets using the random source', () => {
		const e = engine({}, pick(41));
		expect(e.createIntent({ id: 'pi_1', amount: 10000 }, T0).intent.uniqueAmount).toBe(10042);
	});

	it('validates amount and expiry', () => {
		const e = engine();
		expect(code(() => e.createIntent({ id: 'a', amount: 99 }, T0))).toBe('amount_too_small');
		expect(code(() => e.createIntent({ id: 'a', amount: 10_000_001 }, T0))).toBe('amount_too_large');
		expect(code(() => e.createIntent({ id: 'a', amount: 100.5 }, T0))).toBe('invalid_amount');
		expect(code(() => e.createIntent({ id: 'a', amount: 1000, ttlMs: 61 * MIN }, T0))).toBe('invalid_ttl');
		expect(code(() => e.createIntent({ id: 'a', amount: 1000, ttlMs: MIN }, T0))).toBe('invalid_ttl');
	});

	it('keeps a paid amount reserved for the reuse cool-down', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 93000 }, T0).intent;
		e.ingest(sig(a.uniqueAmount), T0 + MIN);
		expect(e.getIntent('pi_a')!.status).toBe('paid');
		// Within the cool-down the next ₹930 intent gets a different amount.
		const b = e.createIntent({ id: 'pi_b', amount: 93000 }, T0 + 2 * MIN).intent;
		expect(b.uniqueAmount).not.toBe(a.uniqueAmount);
		// After the cool-down the amount is free again.
		expect(e.isReserved(a.uniqueAmount, T0 + MIN + 60 * MIN + 1)).toBe(false);
	});

	it('keeps an expired amount reserved for grace + cool-down', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 93000 }, T0).intent;
		const end = a.expiresAt + 30 * MIN + 60 * MIN;
		expect(e.isReserved(a.uniqueAmount, end - 1)).toBe(true);
		e.tick(end - 1);
		expect(e.isReserved(a.uniqueAmount, end)).toBe(false);
	});

	it('offset mode none allows one open intent per amount', () => {
		const e = engine({ offsetMode: 'none' });
		expect(e.createIntent({ id: 'pi_a', amount: 5000 }, T0).intent.uniqueAmount).toBe(5000);
		expect(code(() => e.createIntent({ id: 'pi_b', amount: 5000 }, T0))).toBe('slots_exhausted');
	});
});

describe('matching', () => {
	it('exactly one candidate -> paid (auto)', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 93000, orderId: 'ORD-1' }, T0).intent;
		const r = e.ingest(sig(a.uniqueAmount), T0 + MIN);
		expect(r.signal.status).toBe('matched');
		expect(r.signal.intentId).toBe('pi_a');
		const paid = e.getIntent('pi_a')!;
		expect(paid).toMatchObject({ status: 'paid', paidSource: 'auto', matchedSignalId: r.signal.id, late: false });
		expect(r.changes.events).toContainEqual({ type: 'payment_intent.paid', intentId: 'pi_a' });
	});

	it('zero candidates -> unmatched (customer paid the round amount)', () => {
		const e = engine();
		e.createIntent({ id: 'pi_a', amount: 93000 }, T0);
		const r = e.ingest(sig(93000), T0 + MIN);
		expect(r.signal.status).toBe('unmatched');
		expect(r.changes.events).toContainEqual({ type: 'signal.unmatched', signalId: r.signal.id, reason: 'no_match' });
		expect(e.getIntent('pi_a')!.status).toBe('pending');
	});

	it('two candidates (corrupted state) -> ambiguous, never auto-picks', () => {
		const base = engine();
		base.createIntent({ id: 'pi_a', amount: 93000 }, T0);
		const snap = base.snapshot();
		const twin = { ...snap.intents[0]!, id: 'pi_b' };
		const e = new LocationEngine(DEFAULT_SETTINGS, pick(), { intents: [...snap.intents, twin], signals: [] });
		const r = e.ingest(sig(twin.uniqueAmount), T0 + MIN);
		expect(r.signal.status).toBe('ambiguous');
		expect(e.getIntent('pi_a')!.status).toBe('pending');
		expect(e.getIntent('pi_b')!.status).toBe('pending');
	});

	it('expired within grace -> paid late; after grace -> unmatched', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		const b = e.createIntent({ id: 'pi_b', amount: 2000 }, T0).intent;
		const r1 = e.ingest(sig(a.uniqueAmount, {}, a.expiresAt + MIN), a.expiresAt + 10 * MIN);
		expect(r1.signal.status).toBe('matched');
		expect(e.getIntent('pi_a')!.late).toBe(true);
		const r2 = e.ingest(sig(b.uniqueAmount, {}, b.expiresAt + 31 * MIN), b.expiresAt + 31 * MIN);
		expect(r2.signal.status).toBe('unmatched');
	});

	it('money sent before the intent was created never pays it (offline queue)', () => {
		const e = engine();
		// Old intent paid; its amount is released after the cool-down; a new intent takes it.
		const old = e.createIntent({ id: 'pi_old', amount: 93000 }, T0).intent;
		e.ingest(sig(old.uniqueAmount, {}, T0 + MIN), T0 + MIN);
		const later = T0 + 3 * 60 * MIN;
		const fresh = e.createIntent({ id: 'pi_new', amount: 93000 }, later).intent;
		expect(fresh.uniqueAmount).toBe(old.uniqueAmount); // same amount reused after the cool-down
		// A queued notification of a second payment sent at T0+5min arrives now.
		const r = e.ingest(sig(old.uniqueAmount, { payerShort: 'Other X' }, T0 + 5 * MIN), later + MIN);
		expect(r.signal.status).toBe('unmatched');
		expect(e.getIntent('pi_new')!.status).toBe('pending');
	});

	it('uses the device clock offset for paid_time', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		// Phone clock is 10 min slow: posted_at looks like 9 min before the intent, but it was really 1 min after.
		const r = e.ingest(sig(a.uniqueAmount, { clockOffsetMs: 10 * MIN }, T0 - 9 * MIN), T0 + 2 * MIN);
		expect(r.signal.paidTime).toBe(T0 + MIN);
		expect(r.signal.status).toBe('matched');
	});

	it('a second payment of the same amount does not pay a new intent', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 93000 }, T0).intent;
		e.ingest(sig(a.uniqueAmount, {}, T0 + MIN), T0 + MIN);
		const b = e.createIntent({ id: 'pi_b', amount: 93000 }, T0 + 2 * MIN).intent;
		expect(b.uniqueAmount).not.toBe(a.uniqueAmount);
		const r = e.ingest(sig(a.uniqueAmount, {}, T0 + 4 * MIN), T0 + 4 * MIN);
		expect(r.signal.status).toBe('unmatched');
		expect(e.getIntent('pi_b')!.status).toBe('pending');
	});

	it('reference equal to an intent id narrows the match; wrong amount does not match', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		const r1 = e.ingest(sig(a.uniqueAmount + 1, { reference: 'pi_a' }), T0 + MIN);
		expect(r1.signal.status).toBe('unmatched');
		const r2 = e.ingest(sig(a.uniqueAmount, { reference: 'pi_a' }), T0 + MIN);
		expect(r2.signal.status).toBe('matched');
	});

	it('rejects zero or fractional amounts', () => {
		const e = engine();
		expect(code(() => e.ingest(sig(0), T0))).toBe('invalid_amount');
		expect(code(() => e.ingest(sig(10.5), T0))).toBe('invalid_amount');
	});

	it('ignores signals older than 24 h', () => {
		const e = engine();
		const r = e.ingest(sig(1000, {}, T0 - 25 * 60 * MIN), T0);
		expect(r.signal).toMatchObject({ status: 'ignored', note: 'too_old' });
	});
});

describe('dedupe', () => {
	it('the exact same upload twice is a repeat (no change)', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		const input = sig(a.uniqueAmount);
		const r1 = e.ingest(input, T0 + MIN);
		const r2 = e.ingest({ ...input, id: 'sig_retry' }, T0 + MIN + 5);
		expect(r2.repeat).toBe(true);
		expect(r2.signal.id).toBe(r1.signal.id);
		expect(r2.changes.signals).toHaveLength(0);
	});

	it('the same payment from a backup phone is a duplicate', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		const r1 = e.ingest(sig(a.uniqueAmount, { deviceId: 'dev_a' }, T0 + MIN), T0 + MIN);
		const r2 = e.ingest(sig(a.uniqueAmount, { deviceId: 'dev_b' }, T0 + MIN + 3000), T0 + MIN + 4000);
		expect(r1.signal.status).toBe('matched');
		expect(r2.signal).toMatchObject({ status: 'duplicate', duplicateOf: r1.signal.id });
	});

	it('an updated notification (same key) on one phone is a duplicate', () => {
		const e = engine();
		const r1 = e.ingest(sig(1000, { notificationKeyHash: 'k1' }, T0), T0);
		const r2 = e.ingest(sig(1000, { notificationKeyHash: 'k1' }, T0 + 20_000), T0 + 20_000);
		expect(r2.signal).toMatchObject({ status: 'duplicate', duplicateOf: r1.signal.id });
	});

	it('two real payments of the same amount on one phone are both kept', () => {
		const e = engine();
		const r1 = e.ingest(sig(1000, { notificationKeyHash: 'k1' }, T0), T0);
		const r2 = e.ingest(sig(1000, { notificationKeyHash: 'k2' }, T0 + 10_000), T0 + 10_000);
		expect(r1.signal.status).toBe('unmatched');
		expect(r2.signal.status).toBe('unmatched');
	});

	it('a backup phone copy of each of two real payments pairs one-to-one', () => {
		const e = engine();
		e.ingest(sig(1000, { deviceId: 'dev_a', notificationKeyHash: 'a1' }, T0), T0);
		e.ingest(sig(1000, { deviceId: 'dev_a', notificationKeyHash: 'a2' }, T0 + 5000), T0 + 5000);
		const c1 = e.ingest(sig(1000, { deviceId: 'dev_b', notificationKeyHash: 'b1' }, T0 + 1000), T0 + 6000);
		const c2 = e.ingest(sig(1000, { deviceId: 'dev_b', notificationKeyHash: 'b2' }, T0 + 6000), T0 + 7000);
		const c3 = e.ingest(sig(1000, { deviceId: 'dev_b', notificationKeyHash: 'b3' }, T0 + 7000), T0 + 8000);
		expect(c1.signal.status).toBe('duplicate');
		expect(c2.signal.status).toBe('duplicate');
		expect(c2.signal.duplicateOf).not.toBe(c1.signal.duplicateOf);
		expect(c3.signal.status).toBe('unmatched'); // a third payment only phone B saw
	});

	it('the payment app alert and the bank SMS for one payment count once (either order)', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 100 }, T0).intent;
		const app = e.ingest(sig(a.uniqueAmount, { app: 'google_pay', payerShort: 'Vijaykumar P' }, T0 + MIN), T0 + MIN);
		const sms = e.ingest(sig(a.uniqueAmount, { app: 'bank_sms', payerShort: null }, T0 + MIN + 2000), T0 + MIN + 3000);
		expect(app.signal.status).toBe('matched');
		expect(sms.signal).toMatchObject({ status: 'duplicate', duplicateOf: app.signal.id });

		const b = e.createIntent({ id: 'pi_b', amount: 200 }, T0).intent;
		const sms2 = e.ingest(sig(b.uniqueAmount, { app: 'bank_sms', payerShort: null }, T0 + 2 * MIN), T0 + 2 * MIN);
		const app2 = e.ingest(sig(b.uniqueAmount, { app: 'google_pay', payerShort: 'Asha K' }, T0 + 2 * MIN + 1000), T0 + 2 * MIN + 1000);
		expect(sms2.signal.status).toBe('matched');
		expect(app2.signal).toMatchObject({ status: 'duplicate', duplicateOf: sms2.signal.id });
	});

	it('a real double payment still shows up when both channels report it', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 100 }, T0).intent;
		const amt = a.uniqueAmount;
		const app1 = e.ingest(sig(amt, { app: 'google_pay', payerShort: 'Asha K', notificationKeyHash: 'g1' }, T0 + MIN), T0 + MIN);
		const sms1 = e.ingest(sig(amt, { app: 'bank_sms', payerShort: null, notificationKeyHash: 's1' }, T0 + MIN + 500), T0 + MIN + 500);
		const app2 = e.ingest(sig(amt, { app: 'google_pay', payerShort: 'Asha K', notificationKeyHash: 'g2' }, T0 + MIN + 20_000), T0 + MIN + 20_000);
		const sms2 = e.ingest(sig(amt, { app: 'bank_sms', payerShort: null, notificationKeyHash: 's2' }, T0 + MIN + 21_000), T0 + MIN + 21_000);
		expect(app1.signal.status).toBe('matched');
		expect(sms1.signal).toMatchObject({ status: 'duplicate', duplicateOf: app1.signal.id });
		expect(app2.signal.status).toBe('unmatched'); // the second payment: in the inbox as a possible double payment
		expect(sms2.signal).toMatchObject({ status: 'duplicate', duplicateOf: app2.signal.id });
	});

	it('different payer names across channels are not duplicates', () => {
		const e = engine();
		e.ingest(sig(1000, { app: 'google_pay', payerShort: 'Asha K' }, T0), T0);
		const r = e.ingest(sig(1000, { app: 'bank_sms', payerShort: 'Ravi S' }, T0 + 1000), T0 + 1000);
		expect(r.signal.status).toBe('unmatched');
	});

	it('different UTRs are never duplicates', () => {
		const e = engine();
		e.ingest(sig(1000, { deviceId: 'dev_a', reference: 'UTR1' }, T0), T0);
		const r = e.ingest(sig(1000, { deviceId: 'dev_b', reference: 'UTR2' }, T0), T0);
		expect(r.signal.status).toBe('unmatched');
	});
});

describe('review above auto_confirm_max', () => {
	const settings = { autoConfirmMax: 200_000 }; // ₹2,000

	it('a big match waits for staff; confirm pays it (manual)', () => {
		const e = engine(settings);
		const a = e.createIntent({ id: 'pi_a', amount: 450_000 }, T0).intent;
		const r = e.ingest(sig(a.uniqueAmount), T0 + MIN);
		expect(r.signal).toMatchObject({ status: 'review', intentId: 'pi_a' });
		expect(r.changes.events).toContainEqual({ type: 'signal.review_required', signalId: r.signal.id, intentId: 'pi_a' });
		expect(e.getIntent('pi_a')!.status).toBe('pending');
		e.assignSignal(r.signal.id, 'pi_a', 'user:usr_1', T0 + 2 * MIN);
		expect(e.getIntent('pi_a')).toMatchObject({ status: 'paid', paidSource: 'manual', paidBy: 'user:usr_1' });
		expect(e.getSignal(r.signal.id)!.status).toBe('matched');
	});

	it('reject sends the signal to the inbox; the intent stays pending', () => {
		const e = engine(settings);
		const a = e.createIntent({ id: 'pi_a', amount: 450_000 }, T0).intent;
		const r = e.ingest(sig(a.uniqueAmount), T0 + MIN);
		e.rejectSignal(r.signal.id, T0 + 2 * MIN);
		expect(e.getSignal(r.signal.id)).toMatchObject({ status: 'unmatched', intentId: null });
		expect(e.getIntent('pi_a')!.status).toBe('pending');
	});

	it('a second signal for an intent in review is ambiguous', () => {
		const e = engine(settings);
		const a = e.createIntent({ id: 'pi_a', amount: 450_000 }, T0).intent;
		e.ingest(sig(a.uniqueAmount, { payerShort: 'A B' }), T0 + MIN);
		const r2 = e.ingest(sig(a.uniqueAmount, { payerShort: 'C D' }), T0 + 5 * MIN);
		expect(r2.signal.status).toBe('ambiguous');
	});

	it('small amounts still auto-confirm', () => {
		const e = engine(settings);
		const a = e.createIntent({ id: 'pi_a', amount: 50_000 }, T0).intent;
		expect(e.ingest(sig(a.uniqueAmount), T0 + MIN).signal.status).toBe('matched');
	});

	it('cancelling an intent sends its review signal back to the inbox', () => {
		const e = engine(settings);
		const a = e.createIntent({ id: 'pi_a', amount: 450_000 }, T0).intent;
		const r = e.ingest(sig(a.uniqueAmount), T0 + MIN);
		e.cancel('pi_a', T0 + 2 * MIN);
		expect(e.getSignal(r.signal.id)).toMatchObject({ status: 'unmatched', note: 'intent_closed' });
	});
});

describe('manual actions', () => {
	it('mark paid manually, with an amount mismatch from an inbox signal', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 93000 }, T0).intent;
		const r = e.ingest(sig(93000), T0 + MIN);
		e.assignSignal(r.signal.id, 'pi_a', 'user:u', T0 + 2 * MIN);
		expect(e.getIntent('pi_a')).toMatchObject({ status: 'paid', amountMismatch: true, matchedSignalId: r.signal.id });
		expect(a.uniqueAmount).not.toBe(93000);
	});

	it('cannot pay a cancelled or already-paid intent, or reuse a matched signal', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		e.createIntent({ id: 'pi_b', amount: 2000 }, T0);
		e.createIntent({ id: 'pi_c', amount: 3000 }, T0);
		const r = e.ingest(sig(a.uniqueAmount), T0 + MIN);
		expect(code(() => e.markPaid('pi_a', { by: 'u' }, T0 + MIN))).toBe('invalid_state');
		expect(code(() => e.assignSignal(r.signal.id, 'pi_b', 'u', T0 + MIN))).toBe('invalid_state');
		e.cancel('pi_c', T0 + MIN);
		expect(code(() => e.markPaid('pi_c', { by: 'u' }, T0 + MIN))).toBe('invalid_state');
		expect(code(() => e.markPaid('pi_zzz', { by: 'u' }, T0 + MIN))).toBe('not_found');
	});

	it('undo within 24 h reopens the intent and returns the signal to the inbox', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		const r = e.ingest(sig(a.uniqueAmount), T0 + MIN);
		const ch = e.unmarkPaid('pi_a', 'pending', T0 + 2 * MIN);
		expect(e.getIntent('pi_a')).toMatchObject({ status: 'pending', matchedSignalId: null, reservedUntil: null });
		expect(e.getSignal(r.signal.id)!.status).toBe('unmatched');
		expect(ch.events).toContainEqual({ type: 'payment_intent.unpaid', intentId: 'pi_a' });
	});

	it('undo after 24 h is refused', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		e.ingest(sig(a.uniqueAmount), T0 + MIN);
		expect(code(() => e.unmarkPaid('pi_a', 'pending', T0 + MIN + 24 * 60 * MIN + 1))).toBe('undo_window_passed');
	});

	it('undo to pending is refused if the amount now belongs to another open intent', () => {
		const e = engine({ intentTtlMs: 60 * MIN });
		const a = e.createIntent({ id: 'pi_a', amount: 1000, ttlMs: 60 * MIN }, T0).intent;
		e.ingest(sig(a.uniqueAmount), T0 + MIN);
		const later = T0 + MIN + 61 * MIN; // cool-down over
		const b = e.createIntent({ id: 'pi_b', amount: 1000 }, later).intent;
		expect(b.uniqueAmount).toBe(a.uniqueAmount);
		expect(code(() => e.unmarkPaid('pi_a', 'pending', later + MIN))).toBe('amount_in_use');
		e.unmarkPaid('pi_a', 'cancelled', later + MIN);
		expect(e.getIntent('pi_a')!.status).toBe('cancelled');
	});

	it('claim records the customer tap and never changes status', () => {
		const e = engine();
		e.createIntent({ id: 'pi_a', amount: 1000 }, T0);
		e.claim('pi_a', T0 + MIN);
		expect(e.getIntent('pi_a')).toMatchObject({ status: 'pending', customerClaimedAt: T0 + MIN });
	});
});

describe('expiry, prune and restart', () => {
	it('expires at expires_at and sends the expired event after grace', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		const t1 = e.tick(a.expiresAt);
		expect(e.getIntent('pi_a')!.status).toBe('expired');
		expect(t1.changes.events).toHaveLength(0);
		const t2 = e.tick(a.expiresAt + 30 * MIN);
		expect(t2.changes.events).toContainEqual({ type: 'payment_intent.expired', intentId: 'pi_a' });
		expect(e.tick(a.expiresAt + 31 * MIN).changes.events).toHaveLength(0); // only once
	});

	it('prunes closed intents and old signals, and reports the next wake time', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		expect(e.nextWakeAt()).toBe(a.expiresAt);
		e.cancel('pi_a', T0 + MIN);
		const r = e.tick(T0 + MIN + 60 * MIN);
		expect(r.removedIntentIds).toEqual(['pi_a']);
		expect(e.nextWakeAt()).toBeNull();
	});

	it('a restored engine behaves the same (reserved amounts and dedupe survive)', () => {
		const e = engine();
		const a = e.createIntent({ id: 'pi_a', amount: 1000 }, T0).intent;
		const input = sig(a.uniqueAmount);
		e.ingest(input, T0 + MIN);
		const restored = new LocationEngine(DEFAULT_SETTINGS, pick(), e.snapshot());
		expect(restored.isReserved(a.uniqueAmount, T0 + 2 * MIN)).toBe(true);
		expect(restored.ingest({ ...input, id: 'sig_again' }, T0 + 2 * MIN).repeat).toBe(true);
	});
});
