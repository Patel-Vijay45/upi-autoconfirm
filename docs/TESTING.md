# Testing

Money is involved, so the matching engine gets the most tests.

## 1. Automated tests
### Unit (Vitest)
- **Amount allocation:**
  - Never gives the same `unique_amount` to two open intents at a location.
  - Keeps it reserved for `reuse_cooldown` after paid/cancelled, and after expiry + grace; releases it only then.
  - Picks offsets at random (not the lowest free one).
  - Returns `slots_exhausted` when all 99 are used.
  - After a DO restart, rebuilds the reserved set from `reserved_until` in D1.
- **Matching:**
  - Exactly one candidate → paid; zero → unmatched; two or more → ambiguous; expired-but-in-grace → paid (late).
  - Above `auto_confirm_max` → signal `review`, intent stays `pending`; confirm → paid (manual); reject → unmatched.
  - A signal whose `paid_time` is before the intent's `created_at` (minus 2 min) never matches it.
  - A second payment of the same amount right after a match → unmatched, not matched to a new intent.
- **Dedupe:**
  - The same notification twice (same fingerprint) → one signal.
  - The same payment from two devices → second is `duplicate`.
  - Two real payments of the same amount on one device (different notification keys) → both kept.
- **Parser:**
  - A table of real, redacted notification samples per app and language → expected amount, payer and UTR.
  - It must **reject** "Payment of ₹… failed", "Requested ₹…", "You paid ₹…" (outgoing), promos, and cashback.
- **Webhook signatures:** a valid signature passes; a wrong secret, a tampered body, an old timestamp (> 300 s) or a missing header fails.
- **Device request signature:** wrong body hash, reused nonce or clock skew → 401.
- **Idempotency:** the same key and body return the same intent; the same key with a different body → 409.

### Property tests (fast-check)
- Random streams of create / signal / expire / cancel events across 1–5 locations, with these invariants:
  - An intent is never paid twice.
  - A signal is linked to at most one intent.
  - `paid` intents always have `paid_amount == unique_amount`.
  - Open intents at a location never share an amount.
  - A unique amount is never given to a new intent before the old one's `reserved_until`.
  - No intent is paid by a signal with `paid_time` earlier than its `created_at` − 2 min.
  - Nothing above `auto_confirm_max` becomes `paid` without a staff action.
- Random streams should include backup-device copies, double payments and late offline-queue signals.

### Integration (Miniflare / `wrangler dev`)
- The full flow: API create → device simulator posts a signal → webhook received by a local test server with the signature verified.
- DO restart in the middle of a flow: state rebuilds from D1 and nothing is lost.
- Webhook endpoint returns 500 three times and then 200: the retries arrive and the event id is the same.

### E2E (Playwright)
- **Checkout page:**
  - Amount shown with paise.
  - The app buttons have the correct `upi://` / `gpay://` URLs (`pa`, `pn`, `am`, `tr`, `cu=INR`).
  - The QR decodes to the same URI.
  - The status flips to "Paid ✓" when the simulator sends a signal.
- Returning from the UPI app (`pageshow`) re-checks the status at once.
- Expired screen and the "show this at the counter" fallback.
- Strings for every supported language are present.

### Device simulator
`tools/device-sim.mjs --location loc_a --amount 930.07 --app gpay` signs and sends a notification payload exactly as the Android app would. Use it in CI and for demos without a phone.

## 2. Load and soak
- **k6 or a Node script (see PERFORMANCE.md §6):** 200 intents per minute per location for 30 min, with signals 2–60 s after each one.
  - Target: p95 signal → paid < 3 s.
  - Zero wrong matches.
- **Soak:** 4 h at 20 % of peak. Watch DO memory and D1 row growth.

## 3. Real-device test matrix (manual, before each app release)
Test each row on a real phone: pair → background 30 min → screen off → receive a ₹1 payment → confirmed?

| Phone brand | Android | Known battery issue | Pass? |
|---|---|---|---|
| Xiaomi / Redmi / POCO (MIUI/HyperOS) | 12–15 | Autostart + battery saver kill apps | |
| Samsung (One UI) | 12–15 | "Sleeping apps" list | |
| Vivo / iQOO (Funtouch/OriginOS) | 12–15 | Aggressive background kill | |
| Oppo / Realme (ColorOS) | 12–15 | "Auto launch" off by default | |
| OnePlus (OxygenOS) | 13–15 | Battery optimisation | |
| Motorola / Pixel (stock-like) | 13–15 | Usually fine | |

UPI apps to receive with: Google Pay for Business, PhonePe Business, Paytm for Business, BharatPe, the bank app (SBI YONO / HDFC / ICICI), and the soundbox app if it has one. Test both an English and a Hindi phone language.

## 4. Go-live checklist (per merchant)
- [ ] The UPI ID is the merchant's own business/current account, and the payee name is correct.
- [ ] Phone paired, with notification access ON, battery optimisation OFF, autostart ON and the app locked in recents.
- [ ] ₹1 test from Google Pay, PhonePe and Paytm: all confirmed in under 5 s.
- [ ] Test an **amount mismatch** (pay ₹1 instead of ₹1.03): it shows as unmatched, and staff can assign it.
- [ ] Phone offline test (airplane mode): the dashboard alert arrives and the manual "Mark paid" works.
- [ ] Webhook endpoint returns 200, the signature is verified, and a duplicate event is ignored.
- [ ] Live keys in the server environment only. Nothing secret in front-end code or in git.
- [ ] Staff trained: "never hand over goods for a screenshot; wait for ✓ or check the phone/soundbox".
- [ ] Charger and power bank at the counter; mobile data plus Wi-Fi backup.

## 5. Security tests
- **OWASP ASVS L1** basics on the dashboard and API: auth, session, rate limits, CSRF on dashboard forms, CSP headers.
- **Try:**
  - Using a `pk_` key on secret endpoints.
  - Reading another merchant's intent id with your own key (IDOR) → 404.
  - Sending a device payload signed for location A to location B.
  - Replaying an old signal.
  - A huge body (> 16 KB) → 413.
- Dependency audit (`npm audit`) in CI; a GitHub secret-scanning push-protection check.
