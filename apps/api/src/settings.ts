import { DEFAULT_SETTINGS, type Settings } from '@autoconfirm/core';


/** Merchant settings JSON (merchants.settings, snake_case, seconds) -> engine settings. Unknown keys are ignored. */
export function settingsFromJson(json: string | null | undefined): Settings {
	let raw: Record<string, unknown> = {};
	try {
		raw = json ? (JSON.parse(json) as Record<string, unknown>) : {};
	} catch {
		raw = {};
	}
	const s: Settings = { ...DEFAULT_SETTINGS };
	const int = (k: string) => (typeof raw[k] === 'number' && Number.isInteger(raw[k]) ? (raw[k] as number) : undefined);
	const sec = (k: string, min: number, max: number) => {
		const v = int(k);
		return v === undefined ? undefined : Math.min(max, Math.max(min, v)) * 1000;
	};
	if (raw.offset_mode === 'add_paise' || raw.offset_mode === 'none') s.offsetMode = raw.offset_mode;
	const maxOffset = int('max_offset');
	if (maxOffset !== undefined) s.maxOffset = Math.min(99, Math.max(1, maxOffset));
	s.intentTtlMs = sec('intent_ttl', 120, 3 * 3600) ?? s.intentTtlMs;
	s.maxIntentTtlMs = sec('max_intent_ttl', 120, 3 * 3600) ?? s.maxIntentTtlMs;
	s.graceMs = sec('grace_window', 0, 6 * 3600) ?? s.graceMs;
	s.reuseCooldownMs = sec('reuse_cooldown', 10 * 60, 24 * 3600) ?? s.reuseCooldownMs; // never below 10 min
	if (raw.auto_confirm_max === null) s.autoConfirmMax = null;
	else if (int('auto_confirm_max') !== undefined) s.autoConfirmMax = Math.max(0, int('auto_confirm_max')!);
	s.minAmount = Math.max(100, int('min_amount') ?? s.minAmount);
	s.maxAmount = Math.min(10_000_000, int('max_amount') ?? s.maxAmount);
	if (typeof raw.walk_in_filter === 'boolean') s.walkInFilter = raw.walk_in_filter;
	if (s.intentTtlMs > s.maxIntentTtlMs) s.maxIntentTtlMs = s.intentTtlMs;
	return s;
}
