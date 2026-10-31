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
                ┌────────────────────────── Cloudflare ──────────────────────────┐
 Merchant site ─┤ API Worker (Hono)  ── /v1/*  (secret key)                       │
 (server)       │      │                                                         │
                │      ├──▶ MerchantDO (Durable Object, one per location)        │
 Customer ──────┤ Checkout Worker ── /p/:id, /v1/public/*  (publishable key)     │
 browser        │      │       ▲   live status (WebSocket/SSE)                   │
                │      │       │                                                 │
 Merchant ──────┤ Device Worker ── /device/v1/*  (signed by device secret)       │
 Android app    │      │                                                         │
                │      ▼                                                         │
                │  D1 (accounts, intents, signals, audit)  ·  Queues (webhooks)  │
                │  R2 (exports, parser-rule bundles)  ·  KV (parser rules cache) │
                │  Cron triggers (expiry sweep, device-offline check, cleanup)   │
                └────────────────────────────────────────────────────────────────┘
 Merchant dashboard (SvelteKit on Workers): payments, unmatched inbox, devices, keys, webhooks
```

### 2.1 API Worker (merchant server → us)
- Create, read, cancel and manual-mark payment intents.
- Manage webhook endpoints, list signals, assign unmatched signals.
- Auth: **secret API key** (`sk_live_…`), server-to-server only.

### 2.2 Checkout Worker (customer browser → us)
- Hosted checkout page `/p/:intentId`: QR, app buttons, "I have paid", live status.
- Public status endpoint and a live stream for the merchant's own checkout UI.
- Auth: the **publishable key** (`pk_live_…`) or the unguessable intent id (status only, no personal data).

### 2.3 Device Worker (merchant phone → us)
- Enroll a device with a pairing code, receive signals (payment notifications), heartbeats, and serve parser rules.
- Auth: **per-device secret**, with every request signed by HMAC-SHA256, a timestamp and a nonce.

### 2.4 MerchantDO: the matching engine (Durable Object, one per location)
- The object key is `merchant_id:location_id` (see §5).
- Holds the location's **active intents**, the **reserved amounts** (open intents plus those in their reuse cool-down) and the recent signal fingerprints, in its own SQLite storage.
- **All matching for a location happens here, one at a time.** Durable Objects process one request at a time per object, so two signals can't grab the same intent and the same unique amount is never handed out twice.
- Pushes live updates over WebSocket (hibernation API) to the merchant dashboard and checkout pages.
- Writes results to D1, which is the system of record, and enqueues webhooks.

Why a Durable Object instead of only D1:
- **Single-threaded per location.** Allocation and matching are race-free without database locks.
- **In-memory hot set.** Matching is about 1 ms, with no extra database round trip.
- **Horizontal scale for free.** Each location is independent, so millions of locations means millions of tiny objects.

### 2.5 D1 (system of record)
Merchants, users, keys, devices, payment intents, signals, matches, webhook deliveries and the audit log. See [`db/schema.sql`](../db/schema.sql).
- Start with a single database that has a `merchant_id` column on every row.
- Shard by merchant group when the database nears its size limits (see PERFORMANCE.md).

### 2.6 Queues: webhook delivery
- Each event is retried with exponential backoff (10 s, 1 m, 5 m, 30 m, 2 h, 12 h), then marked failed and shown in the dashboard.
- Every delivery is **signed** (Stripe-style `t=…,v1=…` HMAC) and carries an **event id** so the merchant can ignore duplicates.

### 2.7 Android companion app
- **Kotlin, native.** It uses `NotificationListenerService` to read payment-app notifications.
- **Parses on the device** using rules downloaded from the server, and **sends only what's needed:** amount, app, time, notification key, and optionally the payer name and UPI reference.
- **Offline queue** (Room DB) with retry, a heartbeat every 5 min, and battery-optimisation guidance.
- See [ANDROID-APP.md](ANDROID-APP.md).

### 2.8 Merchant dashboard
SvelteKit on Workers with:
- Payments list and unmatched inbox (one-tap "assign to order")
- Device status (online, last signal, battery hint)
- API keys, webhook endpoints with a delivery log, parser test tool
- Team logins

## 3. Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Cloudflare Workers (TypeScript) | Edge PoPs in India, scale to zero, no servers |
| HTTP framework | Hono | Tiny, fast, Workers-native, typed routes |
| Matching/state | Durable Objects (SQLite-backed, WebSocket hibernation) | Per-location serial execution, live push |
| Database | Cloudflare D1 | SQLite, cheap, point-in-time recovery (Time Travel) |
| Async | Cloudflare Queues + Cron Triggers | Webhook retries, expiry sweeps |
| Cache/config | Workers KV | Parser rules, feature flags |
| Files | R2 | CSV exports, rule bundles |
| Validation | Zod (shared schemas → OpenAPI) | One source of truth |
| Dashboard | SvelteKit + Tailwind | Small bundles, runs on Workers |
| Android | Kotlin, Jetpack (WorkManager, Room, DataStore), OkHttp | Reliability in the background |
| Tests | Vitest + Miniflare, Playwright, k6/autocannon, JUnit + Robolectric (Android) | |
| CI/CD | GitHub Actions → `wrangler deploy` | Simple, built into GitHub |

> **Alternative stack:** if Cloudflare isn't wanted, use Node.js (Fastify) + Postgres (row lock or advisory lock per location for matching) + Redis (pub/sub for live status) + BullMQ (webhooks) on any VPS. The design below doesn't depend on Cloudflare; only the "one actor per location" idea matters.

## 4. Main flows

### 4.1 Create payment
```
Merchant server → POST /v1/payment_intents {amount: 93000, order_id: "ORD-1042"}
  API Worker → MerchantDO.allocate(93000)
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
Device Worker: verify signature/timestamp/nonce → MerchantDO.ingest(signal)
MerchantDO:
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
- **Phone offline:** the heartbeat stops, the merchant is alerted after 10 min, and the checkout shows "Staff will confirm your payment at the counter".
- **Late notification** (after expiry): the service matches against intents expired less than 30 min ago (grace window) and flags `late: true`.

## 5. Multi-tenancy
- Every row has a `merchant_id`. Every query is scoped by it, enforced in a single data-access layer and covered by tests.
- MerchantDO id = `idFromName(merchant_id + ":" + location_id)`.
- Keys, devices and webhooks belong to exactly one merchant.
- **Sub-accounts / locations:** a merchant can have many **locations** (e.g. counters A–D, or branches), each with its own UPI ID and device(s). Matching is per **location**: the DO key is `merchant_id:location_id`, because each location's phone only sees its own UPI ID's payments.

## 6. Environments
- `dev`: Miniflare locally; a fake device simulator posts signals.
- `staging`: real Cloudflare and real test phones; a separate D1, KV and Queues.
- `prod`
- Each environment has its own keys prefix (`sk_test_` / `sk_live_`) and its own UPI test merchant.
