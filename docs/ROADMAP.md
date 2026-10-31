# Roadmap

Start small and real, then generalise.

## Phase 0: Pilot inside the crackers site (1–2 weeks)
Goal: prove the matching works at a real counter with real customers.
- **Crackers site:** unique paise amounts, "Pay with Google Pay / PhonePe / Paytm / other UPI app" buttons and a QR, an "I have paid" screen, and live status.
- **A minimal Android forwarder** (sideloaded APK) for one or two stall phones.
- **Matching inside the existing Worker + LiveHub DO** (no separate service yet).
- **Keep the manual fallback:** staff "UPI received" button and UTR entry.
- **Measure:**
  - Match rate.
  - Time to confirm.
  - How often customers change the amount.
  - Phone-offline incidents.
- **Verify on real phones:**
  - The real notification wording and package names for each payment app (needed for parser rules).
  - Whether Google Pay, PhonePe and Paytm accept the app-specific links (`gpay://`, `phonepe://`, `paytmmp://`) with `tr` set, for a small merchant's UPI ID and at typical order sizes. Some apps block or limit these. Fall back to plain `upi://pay` without `tr` if needed.
- **Exit criteria:** match rate > 95 % and zero wrong confirmations over 300+ payments.

## Phase 1: Standalone service, single tenant (2–4 weeks)
- **New repo** from this folder: API Worker, MerchantDO, D1 schema, webhooks with signatures and retries.
- **Android app v1:**
  - Pairing QR.
  - Signed requests.
  - Offline queue.
  - Remote parser rules.
  - Self-check screen.
- **Integration:** the crackers site moves to calling the API and webhook (INTEGRATION.md).
- **Tooling:** device simulator, test suite, staging environment.

## Phase 2: Multi-tenant for your other client websites (1–2 months)
- **Dashboard (SvelteKit):**
  - Sign up.
  - Locations.
  - Devices.
  - Keys.
  - Webhooks with logs and replay.
  - Signals inbox.
  - Reports.
- **Integration options:**
  - Hosted checkout page and `checkout.js` widget.
  - Examples for Node/PHP/Python.
  - A WooCommerce plugin (big market).
- **Per-merchant setup:** limits, rate limits, audit log, data-retention jobs.
- **Legal review** (COMPLIANCE.md) before onboarding outside merchants.

## Phase 3: Product (later)
- Play Store release (follow the notification-listener policy declaration).
- Plans: free tier (e.g. 300 confirmations/month), then a small flat monthly fee. Never a % of the payment.
- Soundbox and bank-app parsers for more coverage; email-alert parsing as a backup channel.
- Reports: daily settlement summary to match the bank statement; CSV export.
- Optional: an official bank collect API (e.g. a current-account UPI API from a partner bank) as a "pro" signal source with callbacks and no phone needed.
- Shopify / custom-app SDKs; WhatsApp payment links.

## Not planned (on purpose)
- Holding or moving customer money (that would need RBI PA licensing).
- Refunds through the service (merchants refund from their own UPI app).
- Reading SMS or using Accessibility services (Play Store risk and privacy).
- Card payments.
