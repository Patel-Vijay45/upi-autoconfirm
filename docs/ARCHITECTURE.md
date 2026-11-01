# Architecture

## 1. Goals

| Goal | Target |
|---|---|
| Confirmation speed | Payment notification on the phone → merchant webhook in **< 3 s (p95)** |
| Correctness | **Never mark the wrong order paid.** When unsure, ask a human. |
| Money safety | We never hold, route or touch funds. Read-only signals only. |
| Cost | ~₹0 at small scale; flat cost per merchant at large scale (no % fee) |
| Easy integration | Any website: one API call + one webhook, or a drop-in widget |
| Reliability | Manual fallback always works; phone offline → merchant alerted |

## 2. Components

```
                ┌──────────────────────────── Cloudflare (free plan) ─────────────────────────────┐
 Merchant site ─┤ API Worker  apps/api (Hono)                                                     │
 (server)       │   /v1/*            merchant API (secret key or dashboard session)                │
 Customer ──────┤   /p/:id           hosted checkout page; /v1/public/* + /v1/checkout.js (pk_)     │
 browser        │   /device/v1/*     phone API (HMAC-signed by the device secret)                   │
 Phone app ─────┤   /dashboard/v1/*  logins, invites      /admin/v1/*  operator (ADMIN_TOKEN)        │
                │        │                                                                         │
                │        ├──▶ LocationDO  (Durable Object, one per merchant:location:mode)          │
                │        │      runs the matching engine one request at a time, holds live         │
                │        │      WebSockets, writes D1 + queue through an outbox, alarm for expiry   │
                │        ├──▶ PasswordDO  (password hashing; DOs get 30 s CPU on the free plan)     │
                │        ▼                                                                         │
                │  D1 (system of record) · Queue (webhooks, consumer in the same Worker) · KV (rules) │
                │                                                                                  │
 Merchant ──────┤ Dashboard Worker  apps/dashboard (SvelteKit) ──service binding──▶ API Worker      │
 staff browser  └──────────────────────────────────────────────────────────────────────────────────┘
```

All HTTP traffic is handled by **one API Worker**; the "checkout", "device" and "dashboard" parts below are route groups inside it, not separate Workers. The dashboard is a second Worker that only calls the API.

### 2.1 Merchant API (`/v1/*`, merchant server → us)
- Payment intents (create, list, get, cancel, mark/unmark paid), the signals inbox, locations, pairing codes, webhook endpoints, plus the dashboard's endpoints (keys, devices, reports, settings, team, audit log).
- Auth: a **secret API key** (`sk_live_…`/`sk_test_…`) or a **dashboard session** (`ses_…` + `AutoConfirm-Mode`). Roles: `key`, `owner`, `admin`, `staff`, `developer` (API.md §10).

### 2.2 Checkout (customer browser → us)
- Hosted page `/p/:intentId`: amount, app buttons, QR, "I have paid", countdown, live status (WebSocket + polling fallback). Works before JavaScript loads. Strict CSP.
- `checkout.js` widget and `/v1/public/*` (publishable key, CORS) for merchants' own pages.
- The page and widget share one template (`apps/checkout`). Public responses never contain customer data.

### 2.3 Device API (phone → us)
- Enroll with a one-time pairing code, then signed signals, heartbeats (clock offset, listener status) and parser rules (from KV).
- Auth: **per-device secret**; every request is HMAC-signed with a timestamp (±5 min) and a nonce (replays rejected for 10 min).

### 2.4 LocationDO: the matching engine
- One object per `merchant_id:location_id:mode` (`live`/`test`), so test traffic can never touch live intents.
- It runs `packages/core`'s `LocationEngine` and keeps its state (open intents, reserved amounts, recent signals, nonces, idempotency keys) in its own durable storage.
- **One request at a time:** two signals can't grab the same intent, and one unique amount is never handed out twice, with no database locks.
- **Outbox:** state changes and "write this to D1 / send this event" are saved in one storage transaction, then flushed. If D1 or the queue fails, an alarm retries every 5 s; nothing is lost.
- **Live status:** checkout pages connect a WebSocket (hibernation API), and every intent change is pushed.
- **Alarm:** expiry at `expires_at`, the `expired` event after the grace window, pruning, retries.

### 2.5 D1 (system of record)
Merchants, users, sessions, keys, locations, devices, payment intents, signals, events, webhook endpoints and deliveries, audit log, idempotency. See [`db/schema.sql`](../db/schema.sql) and `db/migrations/`. Every row is scoped by `merchant_id`.

### 2.6 Queue: webhook delivery
- The DO enqueues `{eventId}`; the consumer (same Worker) fans out per endpoint, signs (`AutoConfirm-Signature: t=,v1=`), POSTs, records the delivery, and retries at 10 s, 1 m, 5 m, 30 m, 2 h, 12 h, then marks it failed.
- The event id is stable, so merchants can ignore duplicates.

### 2.7 Android app (`apps/android`)
- Kotlin. `NotificationListenerService` reads only packages in the parser rules; parses on the phone; sends only parsed fields, signed.
- Offline queue (Room), heartbeat every 5 min, WorkManager sync every 15 min. See [ANDROID-APP.md](ANDROID-APP.md).

### 2.8 Merchant dashboard (`apps/dashboard`)
- SvelteKit 2 / Svelte 5 on Workers. Covers payments (including "New payment" with a QR), the inbox, counters and phones (pairing QR), developers (keys, webhooks, deliveries, events), reports + CSV, settings, team, activity log and an operator page.
- No database access: every request goes to the API through a **service binding**, so all rules live in the API.

### 2.9 Not built yet (planned)
- Cron jobs: data retention, clean-up of old idempotency rows. (Phone-offline alerts are built: a 5-minute cron in `alerts.ts`.)
- R2 exports/backups (D1 Time Travel covers point-in-time recovery for now).
- Rate limits per merchant/device (login and operator throttling exist).

## 3. Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Cloudflare Workers (TypeScript), free plan | Edge locations in India, scale to zero, no servers |
| HTTP framework | Hono | Tiny, fast, Workers-native |
| Matching/state | Durable Objects (SQLite-backed, WebSocket hibernation) | Per-location serial execution, live push |
| Database | Cloudflare D1 | SQLite, cheap, Time Travel recovery |
| Async | Cloudflare Queues | Webhook delivery and retries |
| Config | Workers KV | Parser rules (published from `rules/parser-rules.json` on deploy) |
| Validation | Zod | Strict request schemas |
| Checkout UI | Plain TypeScript + esbuild, one shared template | ~5 KB `checkout.js`, no framework |
| Dashboard | SvelteKit 2 + Svelte 5 (`@sveltejs/adapter-cloudflare`) | Small bundles, runs on Workers |
| Android | Kotlin, Jetpack Compose, WorkManager, Room, OkHttp, Keystore | Reliability in the background |
| Tests | Vitest + fast-check, `@cloudflare/vitest-plugin` (workerd), Playwright, JUnit | |
| CI/CD | GitHub Actions → `tools/deploy/deploy.mjs` (wrangler) | Push → staging; manual → production |

> **Alternative stack:** if Cloudflare isn't wanted, use Node.js (Fastify) + Postgres (row lock or advisory lock per location for matching) + Redis (pub/sub for live status) + BullMQ (webhooks) on any VPS. The design below doesn't depend on Cloudflare; only the "one actor per location" idea matters.

## 4. Main flows

### 4.1 Create payment
```
Merchant server → POST /v1/payment_intents {amount: 93000, order_id: "ORD-1042"}
  API Worker → LocationDO.createIntent(93000)
     → picks unique_amount 93007 (random free paise offset for this base amount; reserved amounts excluded)
     → stores intent (pending, expires_at = now + 15 min)
  ← {id: "pi_…", unique_amount: 93007, upi: {uri, apps:{gpay,phonepe,paytm}, qr_svg}, checkout_url}
```

### 4.2 Customer pays
The customer taps "Pay with Google Pay", which opens `gpay://upi/pay?...&am=930.07`, and pays in the app. This happens entirely between the customer's app and the merchant's bank; we're not involved.

### 4.3 Signal → match → webhook
```
Phone gets notification "₹930.07 received from Ramesh P" (PhonePe Business)
AutoConfirm app: parse → {amount: 93007, app: "phonepe_business", payer: "Ramesh P", posted_at, key}
  → POST /device/v1/signals (HMAC signed)
Device Worker: verify signature/timestamp/nonce → LocationDO.ingest(signal)
LocationDO:
  dedupe (fingerprint + cross-device window) → find open intents with unique_amount = 93007
     created before the payment was sent (paid_time, corrected for phone clock)
  exactly one → mark PAID, record match, keep the amount reserved for reuse_cooldown
  exactly one but above auto_confirm_max → REVIEW (inbox, staff confirm in one tap)
  zero → store as UNMATCHED (inbox + webhook signal.unmatched)
  more than one → impossible by allocation; if it happens → AMBIGUOUS (inbox, never auto-match)
  → D1 write → Queue webhook payment_intent.paid → live push to checkout + dashboard
```

### 4.4 Fallbacks
- **Manual:** the merchant taps "Mark paid" in the dashboard or calls the API. This is always available and recorded in the audit log.
- **Phone offline:** the heartbeat stops. After 11 min the cron (every 5 min) marks it offline and alerts the merchant (webhook `device.offline`, push alert, dashboard banner). If a payment is created at that counter first, the alert goes out at once, and after "I have paid" the checkout says "show this screen at the counter".
- **Late notification** (after expiry): the service matches against intents expired less than 30 min ago (grace window) and flags `late: true`.

## 5. Multi-tenancy
- Every row has a `merchant_id`. Every query is scoped by it, enforced in a single data-access layer and covered by tests.
- LocationDO id = `idFromName(merchant_id + ":" + location_id + ":" + mode)`.
- Keys, devices and webhooks belong to exactly one merchant.
- **Sub-accounts / locations:** a merchant can have many **locations** (e.g. counters A–D, or branches), each with its own UPI ID and device(s). Matching is per **location**: the DO key is `merchant_id:location_id`, because each location's phone only sees its own UPI ID's payments.

## 6. Environments
- `dev`: Miniflare locally; a fake device simulator posts signals.
- `staging`: real Cloudflare and real test phones; a separate D1, KV and Queues.
- `prod`
- Each environment has its own keys prefix (`sk_test_` / `sk_live_`) and its own UPI test merchant.
