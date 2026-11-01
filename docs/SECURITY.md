# Security

## 1. What we protect
1. **Merchants from losing goods.** An order must never be marked paid when no money arrived.
2. **Customers from double-paying or being told to pay again** when they already paid.
3. **Personal data:** customer names and phones, payer names, payment amounts.
4. **Merchant accounts:** API keys, device secrets, dashboard logins.

We never hold money, so there are no funds to steal. The main risk is **false "paid" confirmations**.

## 2. Threat model

| # | Threat | Impact | Defence |
|---|---|---|---|
| T1 | Customer shows a **fake payment screenshot** | Goods without payment | Confirmation only comes from the **merchant's own phone** notification. Screenshots are never accepted. Staff UI says "Only trust ✓ Paid on this board". |
| T2 | Attacker **forges a device signal** | False "paid" | Per-device secret; HMAC over method, path, timestamp, nonce and body hash; ±5 min window; nonce replay store; device must be `online` and not revoked; rate limit 10 signals/s per device |
| T3 | **Stolen device secret** (rooted phone, malware) | Attacker can mark that location's intents paid | Keystore storage; anomaly alerts (signals with no matching recent intent, burst rates); one-tap revoke; `auto_confirm_max` so big orders need one staff tap (MATCHING §5); optional two-source confirmation |
| T4 | **Replay** of a captured legit signal | Duplicate match | Nonce store + fingerprint dedupe (48 h) |
| T5 | **Leaked secret API key** | Create/cancel/mark-paid on the merchant's account | Hashed at rest, shown once, prefix shown in logs, rotation with 24 h overlap, IP allow-list option, audit log, alerts on new IPs. `mark_paid` via API can be disabled per merchant. |
| T6 | Publishable key misused | Read status of an intent if the id is known | Ids are unguessable (≥ 80-bit random); public status has no personal data; per-IP rate limits |
| T7 | **Webhook spoofing** to the merchant | Merchant fulfils a fake event | HMAC signature + timestamp; docs and examples always verify; also re-fetch the intent before fulfilment |
| T8 | **Wrong match** (two identical amounts, duplicate alert, repeat payment, coincidence) | Wrong order marked paid | Unique-amount reservation is serialized per location in the Durable Object; random offsets plus a reuse cool-down after an intent closes; a signal can't pay an intent created after the money was sent; cross-device dedupe; ambiguous never auto-matches; undo within 24 h; inbox suggestions |
| T9 | **Cross-tenant data leak** | Privacy breach | `merchant_id` in every query via one data-access layer; tests that try cross-tenant ids; DO key includes the merchant |
| T10 | Dashboard account takeover | Everything | Passwords hashed with PBKDF2-SHA256 at 100k iterations (the Workers maximum); **TOTP MFA required** for owner/admin, with codes that can't be reused; sessions stored as hashes, 12 h, ended when a user is deactivated; session cookies `HttpOnly; Secure; SameSite=Lax`; 5 failed logins per email per 15 min; one-time invite links (72 h) instead of emailed passwords |
| T11 | XSS / clickjacking on the checkout page | Altered amounts or UPI ID shown to the customer | Strict CSP (nonce-based scripts), `frame-ancestors` limited to the merchant's registered domains (widget), no user HTML rendered, the UPI ID comes from the server only |
| T12 | **UPI ID swap** (attacker changes the merchant's UPI ID in the dashboard) | Customers pay the attacker | Changing the UPI ID requires MFA re-auth plus an email/SMS alert to the owner; a 1-hour delay before it takes effect (configurable); audit log |
| T13 | Malicious merchant fakes their **own** confirmations | Only affects their own shop | Accepted risk. **Product rule: never use AutoConfirm where a third party must trust the confirmation** (escrow, marketplaces). |
| T14 | DoS / abuse | Outage, cost | Cloudflare WAF + rate limits; per-merchant quotas; Turnstile on public endpoints that create things (none create by default) |
| T16 | **Fake bank SMS** sent to the counter phone ("your A/c is credited with INR 930.07") | False "paid" | SMS are read only when the sender is a bank DLT header on an allow-list (e.g. `JD-IDFCFB-S`); ordinary numbers and lookalikes are rejected (tested in `RealRulesTest`). Use `auto_confirm_max` for expensive orders. |
| T17 | Push-alert subscriptions abused to make the Worker call arbitrary URLs (SSRF), or to read alerts | Internal calls, data leak | Only known push-service hosts are accepted (Google, Mozilla, Apple, Microsoft; HTTPS, default port). Alerts are end-to-end encrypted to the browser (RFC 8291) and carry no payer names. Only signed-in users can subscribe; a deactivated user's subscriptions are deleted; a 404/410 from the push service deletes the subscription |
| T15 | Supply chain | Backdoor | Lockfiles; Renovate with review; minimal dependencies; no third-party SDKs in the Android app; signed releases |

## 3. Keys and secrets
- **API keys:** 32 random bytes, base62, with a prefix (`sk_live_`). Stored as SHA-256. Compared in constant time.
- **Device secret:** 32 random bytes. The server stores `secret_enc` (AES-GCM, with the key in Workers Secrets) because it needs the plaintext to verify HMACs. It also stores `secret_hash` for lookups.
- **Webhook secrets:** like device secrets. Shown once.
- **Rotation:** all secrets can be rotated without downtime (24 h overlap).
- **Workers Secrets** for master keys; never in code or `wrangler.toml`.
- **Backups:** D1 Time Travel. Planned: a nightly encrypted export to R2 (with a separate key).

## 4. Data protection and privacy
- **Minimise:**
  - The payer name is truncated to "Firstname L" on the device.
  - Customer phone is optional, and masked in logs and UI except to the merchant.
  - Raw notification text isn't stored (except redacted parse failures, opt-in, 7 days).
- **Retention defaults:**
  - Signals: 90 days.
  - Payment intents: 1 year. Merchants may need records for tax; let them export and set their own retention.
  - Audit log: 1 year.
  - Parse failures: 7 days.
- **Encryption:** TLS 1.2+ everywhere. Cloudflare encrypts D1 at rest. Secrets have an extra AES-GCM layer.
- **Access:** our staff access production data only through audited admin tools, never raw database access by default.
- **Data subject requests:** delete or export by customer phone across a merchant's data.

## 5. Secure development checklist
- [ ] Zod validation on every input; reject unknown fields on write endpoints.
- [ ] Money as integer paise end to end; no floats in parsing or arithmetic.
- [ ] Every query scoped by `merchant_id` (lint rule plus tests).
- [ ] Constant-time compares for all secrets and signatures.
- [ ] Error messages never echo secrets; logs redact `Authorization`, signatures and phone numbers.
- [ ] Security headers: CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors`.
- [ ] Dependency audit in CI; Android release builds use R8 with `debuggable=false` and signed builds.
- [ ] Pen test before public launch; bug bounty email published (`security@…`).
- [ ] Incident response plan (OPERATIONS.md §5).

## 6. Merchant guidance (put this in the onboarding)
1. **Use a business UPI ID** and keep its app logged in only on the counter phone(s).
2. **Lock the counter phone** with a PIN, and don't install random apps on it.
3. Staff hand over goods **only when the board shows ✓ Paid**, or after checking the payment app or soundbox themselves.
4. If the phone is lost: Dashboard → Devices → **Remove phone**, and change the UPI app PIN.
