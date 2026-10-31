# API (v1)

- **Base URL:** `https://api.<your-domain>/v1`
- **Machine-readable spec:** [`../api/openapi.yaml`](../api/openapi.yaml)
- All amounts are **integers in paise** (₹930.07 = `93007`). Currency is always `INR`.

## 1. Authentication

| Key | Prefix | Where it's used | Can do |
|---|---|---|---|
| Secret key | `sk_live_…` / `sk_test_…` | **Your server only** | Everything for your merchant |
| Publishable key | `pk_live_…` / `pk_test_…` | Browser / widget | Read status of an intent by id; nothing else |
| Device secret | (never shown) | AutoConfirm Android app | Send signals and heartbeats for its location |

Send the key as a header: `Authorization: Bearer sk_live_xxx`

- Keys are stored **hashed** (SHA-256) on our side, and the full key is shown only once at creation.
- Rotate keys from the dashboard; old keys keep working for 24 h after rotation.

## 2. Conventions
- **Idempotency:** send `Idempotency-Key: <uuid>` on every POST. The same key within 24 h returns the same result. Always use it when creating payments, so network retries never create two.
- **Errors:** `{"error": {"type": "invalid_request", "code": "amount_too_small", "message": "…", "param": "amount"}}` with the matching HTTP status (400, 401, 403, 404, 409, 422, 429, 5xx).
- **Rate limits:** 60 requests/s per merchant (burst 120). The `429` response includes `Retry-After`.
- **Versioning:** the URL holds the major version (`/v1`). Fields are only ever **added** within v1. Ignore unknown fields.
- **Pagination:** `?limit=50&starting_after=<id>`
- **Test and live mode are fully separate.** `sk_test_` keys see only test intents, test phones (paired with a test key) and test webhooks. A test phone or the device simulator can never pay a live intent.

## 2a. Locations and phones
- `POST /v1/locations` with `{"name": "Counter 1", "upi_vpa": "shop@ybl", "upi_payee_name": "My Shop"}`. Each location is one UPI ID with its own phone(s).
- `GET /v1/locations`
- `POST /v1/locations/:id/pairing_codes` returns `{code, pairing_link, expires_at}` (valid 10 min, single use).
  - Show `pairing_link` (`autoconfirm://pair?api=…&code=pc_…`) as a QR. The phone's camera opens the app, which sends the code to `/device/v1/enroll`.
  - The phone gets the key's mode (test or live). Set `PUBLIC_API_URL` if the API is reached through a different address than the request came in on.
- A location needs at least one paired phone before it can take payments (`422 location_not_ready`).

## 3. Payment intents

### Create
`POST /v1/payment_intents`
```json
{
  "amount": 93000,
  "location_id": "loc_a",
  "order_id": "ORD-1042",
  "description": "Order ORD-1042",
  "customer": { "name": "Ramesh Patel", "phone": "98XXXXXXXX" },
  "expires_in": 900,
  "return_url": "https://shop.example.com/order/abc123",
  "metadata": { "cart_id": "c_991" }
}
```
`location_id` is optional if the merchant has only one location. `expires_in` is in seconds (default 900); the maximum is the merchant's `max_intent_ttl` (default 1 h, up to 3 h).

**201 Created**
```json
{
  "id": "pi_7h3k2m9q4x",
  "object": "payment_intent",
  "status": "pending",
  "amount": 93000,
  "unique_amount": 93007,
  "display_amount": "930.07",
  "currency": "INR",
  "order_id": "ORD-1042",
  "location_id": "loc_a",
  "expires_at": "2026-11-06T14:20:00Z",
  "checkout_url": "https://pay.<your-domain>/p/pi_7h3k2m9q4x",
  "upi": {
    "uri": "upi://pay?pa=shop@ybl&pn=My%20Shop&am=930.07&cu=INR&tn=ORD-1042&tr=pi_7h3k2m9q4x",
    "apps": {
      "gpay": "gpay://upi/pay?pa=shop@ybl&pn=…&am=930.07&cu=INR&tn=ORD-1042&tr=pi_7h3k2m9q4x",
      "phonepe": "phonepe://pay?pa=shop@ybl&pn=…&am=930.07&cu=INR&tn=ORD-1042&tr=pi_7h3k2m9q4x",
      "paytm": "paytmmp://pay?pa=shop@ybl&pn=…&am=930.07&cu=INR&tn=ORD-1042&tr=pi_7h3k2m9q4x"
    },
    "qr_svg": "<svg …>"
  },
  "paid_at": null,
  "match": null,
  "metadata": { "cart_id": "c_991" }
}
```
Errors: `409 slots_exhausted` (see MATCHING §1.2), `422 location_not_ready` (no UPI ID or no device paired).

### Retrieve
`GET /v1/payment_intents/:id`. Use it to double-check on your server before handing over goods, even after a webhook.

### List
`GET /v1/payment_intents?status=pending&location_id=loc_a&created_after=…`

### Cancel
`POST /v1/payment_intents/:id/cancel`. Allowed only while `pending` or `expired`. The unique amount is released after the reuse cool-down (MATCHING §1), not at once.

### Mark paid manually
`POST /v1/payment_intents/:id/mark_paid` with `{"note": "Verified on soundbox", "signal_id": "sig_…"}` (`signal_id` is optional and links an unmatched signal).

### Undo
`POST /v1/payment_intents/:id/unmark_paid` with `{"reason": "…", "status": "pending"}` (or `"cancelled"`). Allowed within 24 h. Audited, and fires `payment_intent.unpaid`. The linked signal goes back to the inbox. Reopening fails with `409 amount_in_use` if the amount now belongs to another open intent; cancel instead.

### Customer claims payment (public)
`POST /v1/public/payment_intents/:id/claim` (publishable key). It sets `customer_claimed_at`, which is shown to staff as "customer says paid". It never marks the intent paid.

## 4. Signals (what the phone saw)
- `GET /v1/signals?status=unmatched`: the inbox. Also `status=review` (waiting for staff) and `status=ambiguous`.
- `POST /v1/signals/:id/assign` with `{"payment_intent": "pi_…"}`: manual match. If amounts differ, `amount_mismatch` is set and both amounts are recorded.
  - For a `review` signal this is the **Confirm** step. The suggested intent is in the signal's `payment_intent` field.
- `POST /v1/signals/:id/reject` with `{"reason": "…"}`: for a `review` signal. It becomes `unmatched`, and the intent stays `pending`.
- `POST /v1/signals/:id/ignore` with `{"reason": "walk-in customer"}`

Signal statuses: `matched`, `unmatched`, `ambiguous`, `review` (above `auto_confirm_max`, waiting for staff), `ignored`, `duplicate`.

## 5. Live status (for your own checkout UI)
All with the publishable key, and CORS-enabled for any origin:
- **Checkout view:** `GET /v1/public/payment_intents/:id` returns what a checkout shows: `{id, status, amount, unique_amount, display_amount, payee_name, order_id, expires_at, paid_at, return_url, upi: {uri, apps}, qr_svg}`.
- **WebSocket:** `wss://<api>/v1/public/payment_intents/:id/live?key=pk_live_…`.
  - It sends the current status at once, then `{"type":"status","status":"paid","paid_at":"…","expires_at":"…"}` on every change, pushed the moment the phone reports the payment.
  - Browsers can't set headers on WebSockets, which is why the key goes in the query.
  - Up to 10 connections per intent. Send `ping` to get `pong`.
- **Polling fallback:** `GET /v1/public/payment_intents/:id/status` returns `{status, display_amount, paid_at, expires_at}`. Poll every 3 s at most.
- Public responses never include customer personal data or the payer name.

## 5a. Hosted checkout page
`checkout_url` (`https://<checkout host>/p/:id`) is a ready-made payment page. Send the customer there for zero front-end work.
- **What it shows:** the amount in large digits, Google Pay / PhonePe / Paytm / other-app buttons, the QR code (shown first on desktops), a countdown, "I have paid" and a live status.
- **When paid:** it shows "Payment received ✓" and returns the customer to `return_url`.
- **Language:** `?lang=en|hi|gu`, or the browser language.
- **Works without JavaScript:** the amount and pay buttons are in the HTML.
- **Endpoints:** the page uses `/p/:id/status`, `/p/:id/claim` and `wss://…/p/:id/live`. The unguessable intent id is the only credential, and nothing personal is returned.
- **Headers:** strict CSP (nonce scripts, `frame-ancestors 'none'`), `no-store` and `no-referrer`.
- **Hosting:** the page is served by the API Worker. Point `CHECKOUT_BASE_URL` at the host that serves it (the API host itself, or a `pay.` domain routed to the same Worker).

## 6. Webhooks
Configure endpoints in the dashboard or with `POST /v1/webhook_endpoints {url, events[]}`. HTTPS only.

### Events
| Event | When |
|---|---|
| `payment_intent.paid` | Auto or manual match |
| `payment_intent.expired` | TTL passed (and grace window over) |
| `payment_intent.cancelled` | Cancelled |
| `payment_intent.unpaid` | Merchant undid a paid status |
| `signal.unmatched` | Money arrived that matched nothing (or matched ambiguously) |
| `signal.review_required` | Money matched an intent above `auto_confirm_max`; staff must confirm (MATCHING §5) |
| `device.offline` / `device.online` | Phone heartbeat lost or restored |
| `device.parse_failed` | Phone saw a payment notification it couldn't read |

### Payload
```json
{
  "id": "evt_5n2…",
  "type": "payment_intent.paid",
  "created": "2026-11-06T14:07:31Z",
  "livemode": true,
  "data": {
    "object": { "id": "pi_7h3k2m9q4x", "status": "paid", "amount": 93000, "unique_amount": 93007,
                "order_id": "ORD-1042", "paid_at": "2026-11-06T14:07:30Z",
                "match": { "source": "auto", "signal_id": "sig_…", "app": "phonepe_business", "late": false } }
  }
}
```

### Signature (verify every webhook)
Header: `AutoConfirm-Signature: t=1793452051,v1=5f8c…`
```
signed_payload = t + "." + raw_request_body
expected = hex(HMAC_SHA256(webhook_secret, signed_payload))
```
- Accept only if `v1` equals `expected` (constant-time compare) **and** `|now - t| ≤ 300 s`.
- Respond `2xx` within 10 s, and do slow work afterwards.
- Treat `id` as an idempotency key, since the same event can arrive more than once.
- Retries: 10 s, 1 m, 5 m, 30 m, 2 h, 12 h, then marked failed (visible in the dashboard, with manual resend).

## 7. Drop-in checkout widget
```html
<script src="https://pay.<your-domain>/v1/checkout.js" defer></script>
<button id="pay">Pay ₹930</button>
<script>
  document.getElementById('pay').onclick = async () => {
    // 1. Ask YOUR server to create the intent (never put sk_ keys in the browser)
    const { intentId } = await fetch('/api/create-upi-payment', { method: 'POST' }).then(r => r.json());
    // 2. Open the widget (bottom sheet on phones, modal on desktop)
    AutoConfirm.open({
      key: 'pk_live_xxx',
      intent: intentId,
      lang: 'en',                 // en | hi | gu (more later)
      onPaid: (pi) => location.href = '/thank-you?order=' + pi.order_id,
      onExpired: () => alert('Time over. Please try again.'),
      onClose: () => {}
    });
  };
</script>
```
- The widget is about 5 KB gzipped with no dependencies (the build fails above 15 KB). Load it from `https://<api>/v1/checkout.js`.
- It renders in a shadow root: a bottom sheet on phones and a dialog on desktop. On desktop the QR comes first, and the app buttons are never hidden.
- If your site has a Content-Security-Policy, allow `script-src` and `connect-src` for the API host (including `wss:`), and `style-src 'unsafe-inline'` for the widget's own styles.
- `AutoConfirm.open()` returns `{close()}`. `onPaid(pi)` gets `{id, status, order_id, paid_at}`.
- It shows a live status, an "I have paid" button, and the countdown.
- Your server **must still confirm** with a webhook or `GET /v1/payment_intents/:id` before fulfilling. `onPaid` is just for the UI.

## 8. Device API (used only by the Android app)
| Endpoint | Purpose |
|---|---|
| `POST /device/v1/enroll` `{pairing_code, device_info}` | Pair the phone, which receives `device_id` and `device_secret` (once) |
| `POST /device/v1/signals` | Batch of parsed notifications (signed) |
| `POST /device/v1/heartbeat` | Every 5 min: listener status, app versions, queue size, battery-optimisation state, phone clock (`device_time`). The server stores `clock_offset` from it. |
| `GET /device/v1/parser_rules?version=` | Current parser rules (ETag-cached) |
| `POST /device/v1/parse_failures` | Notification text that matched a payment app but couldn't be parsed. Redacted; only if the merchant opted in. |

Signals body (max 50 per request, max 16 KB):
```json
{"signals": [{"app": "phonepe_business", "amount_paise": 93007, "payer_short": "Ramesh P", "reference": null,
              "posted_at": 1793452051000, "notification_key_hash": "9f2c…", "rules_version": "2026-11-06.1"}]}
```
Each result is `{ok, signal_id, status, repeat}`; `repeat: true` means that exact upload was already received.

Heartbeat body: `{"device_time": <phone time, unix ms>, "listener_connected": true, "app_version": "1.0.0", "queue_size": 0, "battery_optimized": false}`.

Signing: headers `X-Device-Id`, `X-Timestamp` (unix **seconds**), `X-Nonce` (16–64 chars of `A-Za-z0-9_-`), and
`X-Signature = hex(HMAC_SHA256(device_secret, method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(body)))`.

The server rejects requests that are more than 5 min skewed or that reuse a nonce within 10 min.

## 9. Operator API (until the dashboard exists)
`POST /admin/v1/merchants` with `Authorization: Bearer <ADMIN_TOKEN>` and `{"name": "…", "settings": {"auto_confirm_max": 500000}}`.
- Returns the merchant id and its four keys (`sk_test_`, `pk_test_`, `sk_live_`, `pk_live_`). They are shown once.
- Disabled when the `ADMIN_TOKEN` secret is not set (or is shorter than 32 characters).
- Settings use the names in MATCHING.md §1.1, with times in seconds.
