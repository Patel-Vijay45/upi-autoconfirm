# Operations: running AutoConfirm in production

## 1. What to watch (dashboards)
| Metric | Healthy | Alert when |
|---|---|---|
| Device heartbeat age (per location) | < 2 min | > 5 min while the location is "open" → push + SMS/WhatsApp to the merchant |
| Signal → paid latency p95 | < 3 s | > 10 s for 5 min |
| Match rate (paid ÷ (paid + unmatched + ambiguous)) | > 97 % | < 90 % over 1 h → parser rules may be broken (app update?) |
| Parse failures per hour | ~0 | > 5 / h for one package → a new notification format |
| `slots_exhausted` errors | 0 | any → raise the offset range or shorten expiry |
| Webhook success rate | > 99 % | < 95 % for one endpoint → email the developer |
| Webhook queue backlog | < 100 | > 1,000 |
| API 5xx rate | < 0.1 % | > 1 % for 5 min |
| DO / D1 errors | 0 | any burst |

Tools on Cloudflare (free or nearly free): Workers Analytics, `wrangler tail`, Logpush (paid) or your own `/internal/metrics` endpoint polled by a free uptime monitor (UptimeRobot / Better Stack free tier).

## 2. Logs
- **Structured JSON** with `request_id`, `merchant_id`, `location_id`, `intent_id`, `signal_id`, `latency_ms`.
- **Never log:** API keys, webhook secrets, device secrets, full payer names, or full notification text (store a hash plus the parsed fields only, see SECURITY.md).
- Keep 30 days; audit_log keeps 1 year.

## 3. Backups
- **D1:** Time Travel (30 days on the paid plan, 7 on free), plus a nightly `wrangler d1 export` to R2 from a Cron trigger. Keep 30 days.
- **Durable Objects:** hold only short-lived state (open intents for 15 min). D1 is the source of truth, so a lost DO rebuilds from D1 on start.
- **Restore drill:** once a quarter, restore yesterday's export into a staging DB and run the test suite against it.

## 4. Runbooks
### R1. "Customer paid but the site says not paid"
1. Dashboard → Location → **Signals**. Look for the amount around the payment time.
2. **Signal is there as `unmatched`** (amount differs, e.g. the customer typed ₹930 instead of ₹930.07) → click **Assign to intent**.
3. **Signal is there as `ambiguous`** → pick the right intent (ask for the last 4 digits of the UTR).
4. **No signal at all** → check the device heartbeat. If the phone was offline, staff verify on the phone/soundbox and use **Mark paid**.
5. If it repeats, check parse failures for that UPI app (R3).

### R2. Device offline
1. Merchant gets an alert. The checkout keeps working: intents stay `pending`, and staff fall back to manual marking.
2. Common causes: battery saver killed the app, notification access was revoked after an OS update, no internet, phone restarted and the app wasn't opened.
3. The app's **Self-check** screen shows which permission is missing. See dontkillmyapp.com for the phone brand.
4. After it reconnects, the app re-sends queued notifications (up to 24 h). Late signals still match intents that are within the grace window.

### R3. A UPI app changed its notification text
1. Parse-failure alerts spike for one package (e.g. `com.phonepe.app.business`).
2. Grab 3–5 redacted samples from `parse_failures`.
3. Write a new rule version in `parser_rules` (KV), test it with the samples in the rule tester (`npm run rules:test`), and roll it out to 10 % of devices, then 100 %.
4. Devices fetch rules every 6 h or on push. No app-store release is needed.
5. Re-process the failed samples from the last 24 h.

### R4. Webhooks failing for a merchant
- Retries: 1 m, 5 m, 30 m, 2 h, 6 h, 12 h, 24 h, then `failed`. Email the developer after 3 failures.
- They can **Replay** from Dashboard → Developers → Webhook log after fixing their endpoint.
- Auto-disable an endpoint after 3 days of continuous failure (email first).

### R5. Suspected fraud (fake "paid" screenshots, replayed notifications)
- AutoConfirm never trusts the customer's screen; only the merchant's device signal counts.
- Replays: the device signature has a nonce plus timestamp, and signals are de-duplicated by fingerprint.
- If a device key may be leaked: Dashboard → Devices → **Revoke**, then re-pair. Its later requests fail with 401.

### R6. Secret leak (sk_ key pushed to GitHub)
1. Roll the key in the dashboard. The old key keeps working for 1 h (or immediately if you choose "revoke now").
2. Check audit_log for use from unknown IPs.
3. Enable GitHub secret scanning partner patterns for the `sk_live_` prefix (later).

## 5. Incident response
- **Severity:** SEV1 = confirmations down for all merchants; SEV2 = one region, app or big merchant; SEV3 = a single location.
- **SEV1 steps:**
  1. Status page "Auto-confirmation delayed, staff please confirm manually".
  2. Find the cause in tail logs and recent deploys.
  3. Roll back with `wrangler rollback`.
  4. After the fix, reconcile: re-run matching for the signals received during the outage.
- Write a short post-mortem within 48 h: what happened, impact, fix, prevention.

## 6. Deploys
- **GitHub Actions:**
  1. lint + typecheck + unit + matching property tests.
  2. Deploy to staging.
  3. Run the e2e suite against staging, using the device simulator (TESTING.md).
  4. Manual approve, then production.
- **Migrations:** additive only (new columns/tables). Remove things in a later release.
- **Avoid peak hours:** no deploys 6 pm–11 pm IST, or during festival weeks (Diwali, Navratri) unless it's a fix.
- **Rollback:** `wrangler rollback`, and the DB stays compatible because of additive migrations.

## 7. Support
- **In-app help:** the "Phone checklist" plus short videos (Gujarati/Hindi/English) for pairing and battery settings.
- WhatsApp support number for merchants; reply targets: 15 min in festival season, otherwise same day.
- **Canned answers:** phone offline, amount mismatch, refund (AutoConfirm can't refund; the merchant refunds from their UPI app), and "is my money safe" (money goes straight to their bank, and AutoConfirm never touches it).

## 8. Data retention jobs (Cron, daily 03:30 IST)
- `signals.raw_text_hash` and parsed fields: 180 days, then delete.
- Payer name: mask after 30 days (`R***h`).
- `idempotency` rows: 24 h. `pairing_codes`: 10 min. `webhook_deliveries`: 30 days.
- Expire `pending` intents past `expires_at` + grace, and emit `payment_intent.expired`.
