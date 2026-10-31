# Integrate AutoConfirm into any website

Five steps, about 1–2 hours for a developer.

## 0. One-time merchant setup (no code)
1. Sign up in the dashboard, then add a **Location** with the business UPI ID and payee name.
2. **Add phone:** install the AutoConfirm app on the counter phone, scan the pairing QR, and complete the checklist.
3. Do a **₹1 test payment** from another phone. The dashboard shows "₹1.00 received ✓".
4. **Developers → API keys:** copy `sk_test_…` (server) and `pk_test_…` (browser).
5. **Developers → Webhooks:** add `https://yoursite.com/webhooks/autoconfirm` and copy the signing secret.

## 1. Server: create a payment when the customer checks out
Never put the `sk_` key in the browser.
```http
POST https://api.<domain>/v1/payment_intents
Authorization: Bearer sk_test_xxx
Idempotency-Key: order-A-31-7
Content-Type: application/json

{"amount": 93000, "order_id": "A-31-7", "return_url": "https://yoursite.com/order/A-31-7"}
```
Save `intent.id` against your order, then either:
- **redirect** the customer to `intent.checkout_url` (zero front-end work), or
- **embed** the widget (step 2), or
- **build your own UI** from `intent.upi.apps.*` links + `intent.upi.qr_svg` + `display_amount`, and the live status (API.md §5).

## 2. Browser: show the payment (widget option)
See [`../examples/checkout.html`](../examples/checkout.html). It's a few lines: load `checkout.js`, then call `AutoConfirm.open({ key, intent, onPaid })`.

## 3. Server: receive the webhook and fulfil the order
- **Verify the signature** (examples in every language below), then on `payment_intent.paid`:
  1. Look up your order by `data.object.order_id` or by the intent id you saved.
  2. **Check** `status == "paid"` and `amount` equals your order total, then mark the order paid.
  3. Make it idempotent: the same event can arrive twice.
- **Belt and braces:** before handing over goods, `GET /v1/payment_intents/:id` and confirm `status: paid`.

## 4. Staff fallback
- Show staff the intent status on your order screen, with a **"Mark paid (checked on phone/soundbox)"** button that calls `POST /v1/payment_intents/:id/mark_paid`.
- Handle `signal.unmatched`: show "₹930.00 received but not matched to an order" so staff can assign it in the dashboard.

## 5. Go live
- Switch to the `sk_live_` / `pk_live_` keys.
- Run the checklist in [TESTING.md](TESTING.md) §4.

---

## Language examples
| File | Stack |
|---|---|
| [`examples/node-express.mjs`](../examples/node-express.mjs) | Node.js 18+ / Express: create + webhook |
| [`examples/verify-webhook.ts`](../examples/verify-webhook.ts) | Any JS runtime with Web Crypto (Cloudflare Workers, Deno, Bun, Node 18+, SvelteKit, Next.js) |
| [`examples/php-wordpress.php`](../examples/php-wordpress.php) | Plain PHP / WordPress / WooCommerce hook |
| [`examples/python-flask.py`](../examples/python-flask.py) | Python / Flask (same idea for Django/FastAPI) |
| [`examples/checkout.html`](../examples/checkout.html) | Widget **and** a no-widget fallback with plain links |

## Plugging into the diwali-ecom (crackers) site
The crackers site already has a per-stall UPI ID, a "Pay now by UPI" option, UTR entry and staff "UPI received" buttons. To switch to AutoConfirm:
1. Map each stall to an AutoConfirm **location** (stall A → `loc_a`, …) and store `autoconfirm_location_id` on `locations`.
2. In `placeOrder` (`src/lib/server/orders.ts`), when payment = UPI, call `POST /v1/payment_intents` with `amount = order.total`, `order_id = token_label` and the stall's location. Store `intent.id` and `unique_amount` on the order.
3. Order page: show `display_amount` (₹930.07) and the app buttons from `intent.upi.apps`, plus an "I have paid" button that calls `/claim`. Subscribe to the live status.
4. New route `POST /api/webhooks/autoconfirm`: verify the signature, then on `payment_intent.paid` run the existing staff action `pay` with `paid_via: 'upi'`. The worker board and customer page then update live through the existing LiveHub.
5. Keep the current UTR and manual buttons as the fallback.
