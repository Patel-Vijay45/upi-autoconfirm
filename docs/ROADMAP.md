# Roadmap

AutoConfirm is a **standalone, reusable service**. Any number of projects (online shops, counters, restaurants, booking sites) plug into it as separate merchants through the same API, webhooks and checkout page. No project is special-cased.

## Step 1: Core service (API + matching engine) ✅ built
**Not done yet (small follow-ups):**
- Rate limits (60 req/s per merchant, 10 signals/s per device).
- Cron jobs: device-offline alerts (`device.offline` / `device.online`), clean-up of old idempotency rows, data retention.
- Live status stream (WebSocket/SSE) for checkout pages. It comes with Step 3.
- Key rotation and revoke endpoints (keys can be revoked in D1 for now).
- Parser-rule publishing tool (rules are read from KV key `active`).

- **Repo layout:** npm workspaces with `packages/core`, `apps/api` and `tools/`.
- **`packages/core`:** pure TypeScript with no platform code.
  - Paise helpers: parse and format, no floats.
  - Unique-amount allocation with random offsets and the reuse cool-down.
  - The matching engine (MATCHING.md §3), including review, dedupe and late signals.
  - Webhook and device signatures, and UPI link building.
- **`apps/api`:** Cloudflare Worker (Hono).
  - Payment intent endpoints, the signals inbox, device enroll, signals and heartbeat.
  - One Durable Object per location runs the engine. D1 is the record.
  - Webhooks are delivered through Queues, signed.
- **Tests:**
  - Unit tests and property tests (fast-check) for every invariant in TESTING.md.
  - A cross-tenant test for each endpoint.
- **`tools/device-sim.mjs`:** signs and sends signals exactly like the phone app.

## Step 2: Android app ✅ built (v0.1), needs real-phone testing
Code in `apps/android` (see its README). Unit tests pass, and its network code was tested against the real API on `wrangler dev`. Still to do:
- Upload of redacted parse failures (needs a server endpoint).
- Hindi and regional-language strings.
- The real-phone checks below.

- Pairing QR.
- Signed requests.
- Offline queue.
- Remote parser rules.
- Clock reporting on heartbeat.
- Self-check screen.
- Verify on real phones:
  - The real notification wording and package names for each payment app (needed for parser rules).
  - Whether Google Pay, PhonePe and Paytm accept the app-specific links (`gpay://`, `phonepe://`, `paytmmp://`) with `tr` set, for a small merchant's UPI ID and at typical order sizes. Some apps block or limit these. Fall back to plain `upi://pay` without `tr` if needed.
- Exit criteria before real use: match rate > 95 % and zero wrong confirmations over 300+ test payments.

## Step 3: Integration kit
- Hosted checkout page and `checkout.js` widget (< 15 KB gzipped).
- `@autoconfirm/node` client library: create intent, verify webhook, retrieve. About 10 lines per project.
- Examples for Node, PHP and Python (see `examples/`).

## Step 4: Dashboard (SvelteKit)
- Merchants, locations, devices (pairing QR), API keys.
- Webhooks with logs and replay.
- Signals inbox (unmatched, ambiguous, review).
- Reports and CSV export.
- Self-serve signup can come later; at first, merchants are created by the operator.

## Step 5: Use-case features
See [USE-CASES.md](USE-CASES.md).
- Unique QR printed on bills (POS / thermal printer).
- Longer expiry per merchant.
- Tip buttons and split bills.
- Table or counter QR stickers that open the current bill.
- WooCommerce plugin; Shopify and other SDKs.

## Step 6: Product (later)
- **Legal review** (COMPLIANCE.md) before onboarding outside merchants.
- Play Store release (follow the notification-listener policy declaration).
- Plans: free tier (e.g. 300 confirmations/month), then a small flat monthly fee. Never a % of the payment.
- Soundbox and bank-app parsers for more coverage; email-alert parsing as a backup channel.
- Optional: an official bank collect API (e.g. a current-account UPI API from a partner bank) as a "pro" signal source with callbacks and no phone needed.

## Not planned (on purpose)
- Holding or moving customer money (that would need RBI PA licensing).
- Refunds through the service (merchants refund from their own UPI app).
- Reading SMS or using Accessibility services (Play Store risk and privacy).
- Card payments.
- Extra steps for the customer (typing a UTR, uploading screenshots). The customer only pays the amount shown.
