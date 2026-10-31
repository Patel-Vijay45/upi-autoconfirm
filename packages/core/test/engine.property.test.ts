// Property tests: random streams of commands against one location's engine.
// After every step the safety invariants from CLAUDE.md / TESTING.md must hold.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DEFAULT_SETTINGS, EngineError, LocationEngine, type EngineState, type Settings } from '../src/engine.ts';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

type Cmd =
	| { k: 'create'; base: number; ttl: number }
	| { k: 'signal'; target: number; delta: number; device: number; payer: number; ago: number; skew: number; keyReuse: boolean }
	| { k: 'advance'; ms: number }
	| { k: 'cancel'; pick: number }
	| { k: 'markPaid'; pick: number; withSignal: number | null }
	| { k: 'reject'; pick: number }
	| { k: 'ignore'; pick: number }
	| { k: 'unmark'; pick: number; to: 'pending' | 'cancelled' }
	| { k: 'claim'; pick: number }
	| { k: 'restart' };

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
	{ weight: 5, arbitrary: fc.record({ k: fc.constant('create' as const), base: fc.constantFrom(10_000, 10_100, 450_000), ttl: fc.constantFrom(2 * MIN, 15 * MIN, 60 * MIN) }) },
	{
		weight: 6,
		arbitrary: fc.record({
			k: fc.constant('signal' as const),
			target: fc.nat(50),
			delta: fc.constantFrom(0, 0, 0, 1, -1, -7),
			device: fc.nat(2),
			payer: fc.nat(2),
			ago: fc.constantFrom(0, 0, 5_000, 3 * MIN, 40 * MIN, 3 * 60 * MIN, 30 * 60 * MIN),
			skew: fc.constantFrom(0, 0, 90_000, -90_000, 10 * MIN),
			keyReuse: fc.boolean(),
		}),
	},
	{ weight: 4, arbitrary: fc.record({ k: fc.constant('advance' as const), ms: fc.constantFrom(1_000, 30_000, 5 * MIN, 20 * MIN, 61 * MIN, 25 * 60 * MIN) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('cancel' as const), pick: fc.nat(50) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('markPaid' as const), pick: fc.nat(50), withSignal: fc.option(fc.nat(50)) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('reject' as const), pick: fc.nat(50) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('ignore' as const), pick: fc.nat(50) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('unmark' as const), pick: fc.nat(50), to: fc.constantFrom('pending' as const, 'cancelled' as const) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('claim' as const), pick: fc.nat(50) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('restart' as const) }) },
);

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return (n: number) => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		return Math.floor(r * n);
	};
}

function checkInvariants(state: EngineState, settings: Settings, paidCount: Map<string, number>) {
	const intents = new Map(state.intents.map((i) => [i.id, i]));
	const signals = new Map(state.signals.map((s) => [s.id, s]));

	// Open intents at a location never share an amount.
	const open = state.intents.filter((i) => i.status === 'pending').map((i) => i.uniqueAmount);
	expect(new Set(open).size).toBe(open.length);

	// An intent is paid by at most one signal; a signal links to at most one intent.
	const usedSignals = new Set<string>();
	for (const i of state.intents) {
		if (i.matchedSignalId) {
			expect(i.status).toBe('paid');
			expect(usedSignals.has(i.matchedSignalId)).toBe(false);
			usedSignals.add(i.matchedSignalId);
			const s = signals.get(i.matchedSignalId);
			if (s) expect(s).toMatchObject({ status: 'matched', intentId: i.id });
		}
		// An auto match is exact, after creation (with clock allowance), and within auto_confirm_max.
		if (i.status === 'paid' && i.paidSource === 'auto') {
			const s = signals.get(i.matchedSignalId!);
			expect(s).toBeDefined();
			expect(s!.amount).toBe(i.uniqueAmount);
			expect(s!.paidTime).toBeGreaterThanOrEqual(i.createdAt - settings.clockAllowanceMs);
			if (settings.autoConfirmMax !== null) expect(i.uniqueAmount).toBeLessThanOrEqual(settings.autoConfirmMax);
		}
	}
	const reviewPerIntent = new Map<string, number>();
	for (const s of state.signals) {
		if (s.status === 'matched') {
			const i = intents.get(s.intentId!);
			if (i) expect(i.matchedSignalId).toBe(s.id);
		}
		if (s.status === 'review') {
			expect(s.intentId).not.toBeNull();
			const i = intents.get(s.intentId!);
			expect(i && (i.status === 'pending' || i.status === 'expired')).toBe(true);
			reviewPerIntent.set(s.intentId!, (reviewPerIntent.get(s.intentId!) ?? 0) + 1);
		}
		if (s.status === 'duplicate') expect(s.duplicateOf).not.toBeNull();
		if (s.status === 'unmatched' || s.status === 'ambiguous' || s.status === 'ignored') expect(s.intentId).toBeNull();
	}
	for (const n of reviewPerIntent.values()) expect(n).toBe(1);

	// Never paid twice at the same time (paid events minus unpaid events is 0 or 1).
	for (const [id, n] of paidCount) {
		expect(n === 0 || n === 1).toBe(true);
		const i = intents.get(id);
		if (i) expect(i.status === 'paid').toBe(n === 1);
	}
}

function run(cmds: Cmd[], seed: number, settings: Settings) {
	const rand = mulberry32(seed);
	let e = new LocationEngine(settings, rand);
	let now = T0;
	let n = 0;
	const paidCount = new Map<string, number>();
	const created: string[] = [];
	const signalIds: string[] = [];
	const amounts: number[] = [];

	const pickFrom = <T>(arr: T[], k: number): T | undefined => (arr.length ? arr[k % arr.length] : undefined);
	const apply = (events: { type: string; intentId?: string }[]) => {
		for (const ev of events) {
			if (ev.type === 'payment_intent.paid') paidCount.set(ev.intentId!, (paidCount.get(ev.intentId!) ?? 0) + 1);
			if (ev.type === 'payment_intent.unpaid') paidCount.set(ev.intentId!, (paidCount.get(ev.intentId!) ?? 0) - 1);
		}
	};

	for (const c of cmds) {
		try {
			switch (c.k) {
				case 'create': {
					const id = `pi_${n++}`;
					const before = e.snapshot();
					const r = e.createIntent({ id, amount: c.base, ttlMs: c.ttl }, now);
					// The new amount was not reserved by any other intent.
					for (const o of before.intents) {
						const reserved = o.status === 'pending' || (o.reservedUntil !== null && o.reservedUntil > now);
						if (reserved) expect(o.uniqueAmount).not.toBe(r.intent.uniqueAmount);
					}
					created.push(id);
					amounts.push(r.intent.uniqueAmount);
					apply(r.changes.events);
					break;
				}
				case 'signal': {
					const target = pickFrom(amounts, c.target) ?? 10_001;
					const amount = Math.max(1, target + c.delta);
					const id = `sig_${n++}`;
					const key = c.keyReuse && signalIds.length ? `k_last` : `k_${id}`;
					const r = e.ingest(
						{
							id,
							deviceId: `dev_${c.device}`,
							app: 'gpay_business',
							amount,
							payerShort: ['Ramesh P', 'Sita K', null][c.payer]!,
							notificationKeyHash: key,
							postedAt: now - c.ago - c.skew,
							clockOffsetMs: c.skew,
						},
						now,
					);
					if (!r.repeat) signalIds.push(id);
					apply(r.changes.events);
					break;
				}
				case 'advance': {
					now += c.ms;
					apply(e.tick(now).changes.events);
					break;
				}
				case 'cancel': {
					const id = pickFrom(created, c.pick);
					if (id) apply(e.cancel(id, now).events);
					break;
				}
				case 'markPaid': {
					const id = pickFrom(created, c.pick);
					const sid = c.withSignal === null ? null : pickFrom(signalIds, c.withSignal) ?? null;
					if (id) apply(e.markPaid(id, { by: 'user:t', signalId: sid }, now).events);
					break;
				}
				case 'reject': {
					const sid = pickFrom(signalIds, c.pick);
					if (sid) apply(e.rejectSignal(sid, now).events);
					break;
				}
				case 'ignore': {
					const sid = pickFrom(signalIds, c.pick);
					if (sid) apply(e.ignoreSignal(sid, now).events);
					break;
				}
				case 'unmark': {
					const id = pickFrom(created, c.pick);
					if (id) apply(e.unmarkPaid(id, c.to, now).events);
					break;
				}
				case 'claim': {
					const id = pickFrom(created, c.pick);
					if (id) apply(e.claim(id, now).events);
					break;
				}
				case 'restart': {
					e = new LocationEngine(settings, rand, e.snapshot());
					break;
				}
			}
		} catch (err) {
			if (!(err instanceof EngineError)) throw err; // only expected, typed refusals are allowed
		}
		checkInvariants(e.snapshot(), settings, paidCount);
	}
}

describe('engine invariants (property)', () => {
	it('hold with default settings', () => {
		fc.assert(
			fc.property(fc.array(cmd, { minLength: 1, maxLength: 120 }), fc.integer(), (cmds, seed) => run(cmds, seed, DEFAULT_SETTINGS)),
			{ numRuns: 400 },
		);
	});

	it('hold with few offsets and a review limit (more collisions)', () => {
		const settings: Settings = { ...DEFAULT_SETTINGS, maxOffset: 3, autoConfirmMax: 200_000 };
		fc.assert(
			fc.property(fc.array(cmd, { minLength: 1, maxLength: 120 }), fc.integer(), (cmds, seed) => run(cmds, seed, settings)),
			{ numRuns: 400 },
		);
	});

	it('hold with exact amounts (offset mode none)', () => {
		const settings: Settings = { ...DEFAULT_SETTINGS, offsetMode: 'none' };
		fc.assert(
			fc.property(fc.array(cmd, { minLength: 1, maxLength: 80 }), fc.integer(), (cmds, seed) => run(cmds, seed, settings)),
			{ numRuns: 200 },
		);
	});
});
