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

## 3. Payment intents

### Create
`POST /v1/payment_intents`
```json
{
  "amount": 93000,
  "location_id": "loc_a",
  "order_id": "A-31-7",
  "description": "Shreenathji Crackers order A-31-7",
  "customer": { "name": "Ramesh Patel", "phone": "98XXXXXXXX" },
  "expires_in": 900,
  "return_url": "https://shop.example.com/order/abc123",
  "metadata": { "cart_id": "c_991" }
}
```
`location_id` is optional if the merchant has only one location.

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
  "order_id": "A-31-7",
  "location_id": "loc_a",
  "expires_at": "2026-11-06T14:20:00Z",
  "checkout_url": "https://pay.<your-domain>/p/pi_7h3k2m9q4x",
  "upi": {
    "uri": "upi://pay?pa=shop@ybl&pn=Shreenathji%20Crackers&am=930.07&cu=INR&tn=A-31-7&tr=pi_7h3k2m9q4x",
    "apps": {
      "gpay": "gpay://upi/pay?pa=shop@ybl&pn=…&am=930.07&cu=INR&tn=A-31-7&tr=pi_7h3k2m9q4x",
      "phonepe": "phonepe://pay?pa=shop@ybl&pn=…&am=930.07&cu=INR&tn=A-31-7&tr=pi_7h3k2m9q4x",
      "paytm": "paytmmp://pay?pa=shop@ybl&pn=…&am=930.07&cu=INR&tn=A-31-7&tr=pi_7h3k2m9q4x"
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
`POST /v1/payment_intents/:id/unmark_paid` with `{"reason": "…"}`. Allowed within 24 h. Audited, and fires `payment_intent.unpaid`.

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
- **WebSocket:** `wss://pay.<your-domain>/v1/public/payment_intents/:id/live?key=pk_live_…` sends `{"type":"status","status":"paid","paid_at":"…"}`.
- **Server-Sent Events:** `GET /v1/public/payment_intents/:id/events`, with the same messages.
- **Polling fallback:** `GET /v1/public/payment_intents/:id/status` returns `{status, paid_at, expires_at}`. Poll every 3 s at most.
- Public responses never include customer personal data or the payer name.

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
                "order_id": "A-31-7", "paid_at": "2026-11-06T14:07:30Z",
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
      lang: 'gu',                 // gu | hi | en
      onPaid: (pi) => location.href = '/thank-you?order=' + pi.order_id,
      onExpired: () => alert('Time over. Please try again.'),
      onClose: () => {}
    });
  };
</script>
```
- The widget is under 15 KB gzipped with no dependencies.
- It detects Android, iPhone or desktop. It shows the app buttons on phones and a QR on desktop.
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

Signing: headers `X-Device-Id`, `X-Timestamp`, `X-Nonce`, and
`X-Signature = hex(HMAC_SHA256(device_secret, method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(body)))`.

The server rejects requests that are more than 5 min skewed or that reuse a nonce within 10 min.
