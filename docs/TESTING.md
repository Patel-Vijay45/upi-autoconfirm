# Testing

Money is involved, so the matching engine gets the most tests. Everything below runs in CI (`.github/workflows/ci.yml`) except the browser e2e and the real-device checks.

## 0. How to run

| What | Command | Where it runs |
|---|---|---|
| Everything automatic | `npm test` | core → Node client → checkout asset check → API (in workerd) |
| Type checks | `npm run typecheck` | all TS + `svelte-check` for the dashboard |
| Engine only | `npm test -w @autoconfirm/core` | Node |
| API only | `npm test -w @autoconfirm/api` | workerd via `@cloudflare/vitest-plugin` (real D1, Durable Objects, Queues) |
| Android | `cd apps/android && ./gradlew testDebugUnitTest` | JVM |
| Browser e2e | start the API (`wrangler dev`) and the dashboard (`vite dev`), then `npm run test:e2e` | Playwright Chromium |
| e2e against staging | `E2E_API=https://autoconfirm-api-staging.<sub>.workers.dev E2E_DASH=https://autoconfirm-dashboard-staging.<sub>.workers.dev E2E_ADMIN_TOKEN=… npm run test:e2e` | live Cloudflare |
| Deploy check | `node tools/deploy/deploy.mjs --env production --dry-run` | builds both Workers, validates configs and rules |

## 1. Automated tests

### Core engine (`packages/core/test`)
- **Unit (`engine.test.ts`):**
  - Allocation: random offsets in 1–99; never the same amount for two open intents; reserved for `reuse_cooldown` after paid/cancelled and after expiry + grace; `slots_exhausted` when full; rebuilt after a restart.
  - Matching: exactly one → paid; zero → unmatched; two or more → ambiguous; expired within grace → paid (late); a payment sent before the intent was created never matches it; the phone clock offset is applied.
  - Dedupe: the same upload twice → one signal; the same payment from two phones → duplicate; two real payments on one phone → both kept.
  - Review above `auto_confirm_max`; manual mark paid, undo, cancel, claim; expiry events; prune.
- **Property (`engine.property.test.ts`, fast-check):** random streams of create / signal / advance time / cancel / mark paid / reject / ignore / undo / claim / **restart**, with three settings profiles. After every step:
  - An intent is never paid twice; a signal links to at most one intent.
  - Open intents never share an amount; a new amount is never one that's still reserved.
  - Auto matches are exact, after creation, and within `auto_confirm_max`; at most one review signal per intent.
  - Mutation-checked: removing the paid-after-created check or the cool-down makes these fail.
- Also: money (paise round-trip), signatures (webhook + device), QR (decoded with jsQR), TOTP (RFC 6238 vectors).

### Node client (`packages/node/test`)
Requests, idempotency header, error mapping, retries only for safe calls, webhook `constructEvent` against the server's own signing code.

### API (`apps/api/test`, in workerd)
- `api.test.ts`: payment intents (idempotency, validation, parallel creates), matching through the API, review flow, test/live separation, device security (bad signature, replayed nonce, clock skew, revoked phone, single-use pairing), parser rules endpoint, webhook delivery and retries, payer names, **cross-tenant checks for every endpoint**.
- `checkout.test.ts`: hosted page (amount, links, QR, strict CSP, no customer data, en/hi/gu), status/claim, **live WebSocket push on payment**, widget endpoints, CORS, tenancy.
- `dashboard.test.ts`: invites + TOTP setup, login (wrong password, OTP required, OTP replay, lockout), operator-token throttling, roles, keys shown once, phones, settings changing matching, inbox suggestions, reports + CSV (formula-injection safe), webhooks/events, audit log, **cross-tenant checks with sessions and keys**.

### Checkout assets
`npm run check -w @autoconfirm/checkout` fails if `apps/api/src/generated/checkout-assets.ts` is stale or `checkout.js` is over 15 KB gzipped.

### Android (`apps/android/app/src/test`)
- `ParserTest`: money, payer names, rule loading, ignore patterns, parse failures, broken rules skipped.
- `NetTest`: request signing is byte-identical to the server (shared vector), request format, rule caching, pairing links (HTTPS only).
- **`RealRulesTest`: the live `rules/parser-rules.json` against notifications captured on real phones.** Add a sample here for every rule change.
- `ServerE2ETest`: the app's network code against a running API (skipped unless `AUTOCONFIRM_E2E_LINK` and `AUTOCONFIRM_E2E_AMOUNT` are set).

### Browser e2e (`tools/e2e`)
- `checkout.e2e.mjs`: hosted page on a phone (links, countdown, "I have paid", paid within 3 s, redirect), desktop (QR first, Hindi), and the widget embedded on another site (`onPaid`, Escape closes).
- `dashboard.e2e.mjs`: the operator page creates a shop → owner setup with TOTP → test mode → add counter → pair a phone → **New payment → QR → phone signal → turns Paid by itself** → auto + inbox matching → reports + CSV → keys shown once → settings → staff invite and limited menu → logout/login.

## 2. Load and soak (planned)
- 200 intents per minute per location for 30 min, with signals 2–60 s after each one. Target: p95 signal → paid < 3 s, zero wrong matches.
- Soak: 4 h at 20 % of peak; watch DO memory and D1 row growth.

## 3. Real-device test matrix (manual, before each app release)
Test each row on a real phone: pair → background 30 min → screen off → receive a ₹1 payment → confirmed?

| Phone brand | Android | Known battery issue | Pass? |
|---|---|---|---|
| Xiaomi / Redmi / POCO (MIUI/HyperOS) | 12–15 | Autostart + battery saver kill apps | |
| Samsung (One UI) | 12–15 | "Sleeping apps" list | |
| Vivo / iQOO (Funtouch/OriginOS) | 12–15 | Aggressive background kill | |
| Oppo / Realme (ColorOS) | 12–15 | "Auto launch" off by default | |
| OnePlus (OxygenOS) | 13–15 | Battery optimisation | |
| Motorola / Pixel / Nothing (stock-like) | 13–16 | Usually fine | ✓ pairing + Google Pay notification captured 2026-11-01 |

Payment apps to receive with: Google Pay ✓ (verified), PhonePe, Paytm, BharatPe, a bank app, and the soundbox app if there is one. Test an English and a Hindi phone language.

## 4. Go-live checklist (per merchant)
- [ ] The UPI ID is the merchant's own business/current account, and the payee name is correct.
- [ ] Phone paired: notification access ON (restricted settings allowed), battery **Unrestricted**, autostart ON, rules ✓.
- [ ] ₹1 test via **New payment** from Google Pay, PhonePe and Paytm: all show **Paid ✓** in under 5 s.
- [ ] Test an **amount mismatch** (pay ₹1 instead of ₹1.37): it shows as unmatched, and staff can match it.
- [ ] Phone offline test (airplane mode): the dashboard shows it offline, and manual "Mark paid" works.
- [ ] If a website is connected: the webhook endpoint returns 200, the signature is verified, and a duplicate event is ignored.
- [ ] Live keys only in the server environment. Nothing secret in front-end code or in git.
- [ ] Staff trained: "never hand over goods for a screenshot; wait for ✓ or check the phone/soundbox".
- [ ] Charger and power bank at the counter; mobile data plus Wi-Fi backup.

## 5. Security tests
- Automated: wrong key kinds, cross-tenant ids (404), signed-for-another-device payloads, replayed signals and nonces, bodies > 16 KB (413), login and operator brute force (429), CSV formula injection, CSP headers.
- Manual before public launch: OWASP ASVS L1 on the dashboard and API; dependency audit (`npm audit`); GitHub secret scanning.
