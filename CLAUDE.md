# CLAUDE.md

Notes for Claude Code sessions working on this repository.

## Project
**UPI AutoConfirm** confirms UPI payments to a merchant's own UPI ID automatically, with no payment gateway and no % fee.
- Each payment gets a unique paise amount (₹930.07).
- An Android app on the merchant's phone forwards "money received" notifications.
- The server matches them and fires signed webhooks to the merchant's website.

Read [README.md](README.md), then [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (repo map, flows, how-to recipes) and [docs/MATCHING.md](docs/MATCHING.md) before changing anything. Why things are the way they are: [docs/DECISIONS.md](docs/DECISIONS.md). All docs: [docs/README.md](docs/README.md).

## Stack
- **Server:**
  - Cloudflare Workers + Hono, written in TypeScript.
  - Durable Object `LocationDO`, one per `merchant:location:mode`. It runs the matching engine, the outbox and live WebSockets. `PasswordDO` hashes passwords.
  - D1 is the source of truth. Queues deliver webhooks and push alerts, KV holds parser rules. A 5-minute cron marks phones offline (`alerts.ts`).
- **Android app:** Kotlin, NotificationListenerService, Room, WorkManager, OkHttp, Keystore.
- **Dashboard:** SvelteKit on Cloudflare.
- **Contracts:** API in [api/openapi.yaml](api/openapi.yaml), schema in [db/schema.sql](db/schema.sql).

## Rules that matter
- **We never touch money.** No holding funds, no refunds, no payouts (see docs/COMPLIANCE.md).
  - Market it as "UPI payment confirmation", not a "payment gateway".
- **Money is integer paise everywhere.** Never use floats.
- **Matching safety:**
  - A signal marks an intent paid only when **exactly one** open intent at that location has that exact amount.
  - The payment must have been sent after the intent was created (`paid_time`, corrected for phone clock).
  - Above `auto_confirm_max` the signal goes to `review` for one staff tap; the intent stays `pending`.
  - Otherwise it is `unmatched` or `ambiguous`, for a human to resolve.
  - Never guess.
  - A unique amount stays reserved for `reuse_cooldown` after its intent closes. Offsets are picked at random.
- **Invariants (keep the property tests green):**
  - An intent is paid at most once.
  - A signal links to at most one intent.
  - Open intents at a location never share an amount.
  - A unique amount is not reused before the old intent's `reserved_until`.
- **Idempotency:** every create call takes `Idempotency-Key`; webhooks carry a stable `event.id`; signals are de-duplicated by fingerprint.
- **Signatures:** webhooks use `AutoConfirm-Signature: t=,v1=` (HMAC-SHA256, ±300 s). Device requests are HMAC-signed with a nonce.
- **Tenancy:** every query is filtered by `merchant_id` (and `location_id`). A test must cover each new endpoint for cross-tenant access.
- **Secrets:**
  - Never log keys, secrets, full payer names or raw notification text.
  - Store key hashes only. Show the full key once, at creation.
- **Android:**
  - Never request SMS or Accessibility permissions. Send only parsed fields plus a text hash.
  - Parser rules come from the server (KV), so a format change needs no app release.
- **Performance:**
  - p95 signal → paid < 3 s.
  - `checkout.js` under 15 KB gzipped. The hosted checkout page has no framework and no heavy libraries.
- **Cost:** stay inside Cloudflare free/cheap tiers. Ask before adding paid services.
  - It runs on the Workers Free plan: 10 ms CPU per request, so heavy CPU work (e.g. password hashing) goes in a Durable Object, which gets 30 s.
- **Migrations:** additive only. Add new numbered files and never edit applied ones.

## Working style
- The owner often works from the Claude mobile app, so keep replies short and readable on a phone.
- Commit and push before finishing; cloud containers are temporary.
- Work on a feature branch, not directly on the default branch.

## Code layout
- `packages/core`: pure TypeScript (engine, money, signatures, UPI links). No platform code. Most safety logic lives here.
- `apps/api`: Cloudflare Worker (Hono routes, `LocationDO` with live WebSockets, webhook queue consumer, hosted checkout `/p/:id`).
- `apps/checkout`: browser code for the hosted page and `checkout.js`, plus the shared template, CSS and i18n. `npm run build` writes `apps/api/src/generated/checkout-assets.ts` (commit it; `npm test` fails if stale or over 15 KB).
- `packages/node`: `@autoconfirm/node` server client (no dependencies).
- `apps/dashboard`: SvelteKit 2 (Svelte 5) merchant dashboard on Cloudflare. A thin UI: its server calls the API with the user's session (service binding `API` in production, `API_URL` in dev). All access rules live in the API.
  - Use `defaultValue` (not `value`) on form inputs, so text typed before hydration isn't wiped.
- `db/schema.sql` is the full schema; `db/migrations/` holds applied migrations (add new numbered files only).
- `apps/android`: Kotlin phone app (Gradle project, not part of npm workspaces). Pure logic in `parse/` and `net/` is unit-tested on the JVM.
- `rules/parser-rules.json`: the **live** parser rules. Every deploy publishes them to KV `active`; phones fetch them within 15 min. Add a real captured sample to `apps/android/.../RealRulesTest.kt` for every rule change.
- `tools/device-sim.mjs`: signs and sends signals like the phone app. `tools/rules/example.json`: an older template.

## Commands
- Install: `npm install`
- Dev: `npm run dev` (wrangler dev; needs `apps/api/.dev.vars` and `npx wrangler d1 migrations apply autoconfirm --local` in `apps/api`)
- Tests: `npm test` (core, node client, checkout asset check, API tests in the Workers runtime). Typecheck: `npm run typecheck`
- Dashboard dev: `cd apps/dashboard && API_URL=http://127.0.0.1:8787 npx vite dev` (port 5173). Type check: `npm run check -w @autoconfirm/dashboard`
- Browser e2e: start the API (`wrangler dev`) and the dashboard, then `npm run test:e2e` (Playwright Chromium). Dashboard e2e uses E2E_DASH (default http://127.0.0.1:5173).
- Device simulator: `node tools/device-sim.mjs pair --code pc_… --api http://localhost:8787`, then `node tools/device-sim.mjs signal --amount 930.07`
- Android: `cd apps/android && ./gradlew testDebugUnitTest assembleDebug` (needs JDK 17+ and Android SDK 36)
- Deploy: see docs/DEPLOY.md. Push to `main` deploys staging; "Run workflow" deploys staging then production (`tools/deploy/deploy.mjs`). Dry run: `node tools/deploy/deploy.mjs --env production --dry-run`
- Operator: `node tools/admin.mjs create-merchant --api <url> --name … --owner <email>` (needs AUTOCONFIRM_ADMIN_TOKEN)

## Scope
- This is a generic, reusable service. Never add project-specific code, names or special cases. Every project is just a merchant using the public API (see docs/USE-CASES.md).
