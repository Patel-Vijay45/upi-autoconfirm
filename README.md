# UPI AutoConfirm

**Zero-fee UPI payments with automatic confirmation, for any small business website.**
(Working name. Check trademarks before choosing a final name.)

Customers pay with Google Pay, PhonePe, Paytm, BHIM or any UPI app straight into the **merchant's own UPI ID**. The service tells the merchant's website **"order X is paid"** within seconds. There is no payment gateway, no MDR or percentage fee, and the money never passes through us.

> **Status:** Steps 1–3 are built and tested: the API and matching engine, the Android app (v0.1) and the checkout page with `checkout.js`. Next: the dashboard, deployment and real-phone testing. See [docs/ROADMAP.md](docs/ROADMAP.md).
> AutoConfirm is a standalone, reusable service. Any project (online shop, counter, restaurant, bookings) plugs in as a merchant through the same API. See [docs/USE-CASES.md](docs/USE-CASES.md).

## How it works

1. **The merchant's site creates a payment.** For example, the order total is ₹930.
2. **The service makes the amount unique** (₹930.07) and returns "Pay with GPay / PhonePe / Paytm / other UPI app" links and a QR code.
3. **The customer pays** in their UPI app, straight to the merchant's own business UPI ID.
4. **The merchant's counter phone gets the normal alert:** "₹930.07 received from Ramesh…".
5. **The AutoConfirm Android app** on that phone sends the alert to the service, signed and secure.
6. **The service matches ₹930.07** to the open payment and marks it **PAID**.
7. **The merchant's site is told** through a webhook and live update, and the customer sees "Payment received ✓".

```
Customer phone ──pays──▶ Merchant's UPI ID (their bank)        money: direct, never through us
                               │
                               ▼ "₹930.07 received" notification
                     Merchant's Android phone
                     (AutoConfirm app)
                               │ signed HTTPS
                               ▼
Merchant website ◀──webhook── AutoConfirm service ── match ──▶ payment_intent = PAID
        ▲                              │
        └── live status (SSE/WS) ──────┘──▶ customer's checkout page shows ✓
```

## Why

| | Payment gateway | AutoConfirm |
|---|---|---|
| Fee per payment | ~1.95–2% + 18% GST (as of Oct 2026) | **₹0** (flat monthly subscription if sold) |
| Who holds the money | Gateway, then settles T+1/T+2 | **The merchant's bank account, instantly** |
| Business restrictions | Some business categories refused | Any business that can get a business UPI ID |
| Automatic confirmation | Yes | Yes (via the merchant's phone), plus manual fallback |
| Refunds, cards, net banking | Yes | **No**: UPI only, refunds done by the merchant |

## Run it locally
```bash
npm install
npm test
```
To run the API and try it with the device simulator, see "Commands" in [CLAUDE.md](CLAUDE.md).

## Documents

| File | What's inside |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, components, tech stack, data flow, multi-tenancy |
| [docs/MATCHING.md](docs/MATCHING.md) | The unique-amount algorithm, edge cases, state machine |
| [docs/API.md](docs/API.md) | REST API, webhooks, live status, JS checkout widget (human-readable) |
| [api/openapi.yaml](api/openapi.yaml) | Machine-readable API spec (OpenAPI 3.1) |
| [db/schema.sql](db/schema.sql) | Database schema (Cloudflare D1 / SQLite) |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | Add it to any website: Node, SvelteKit, PHP/WordPress, Python, plain HTML |
| [docs/ANDROID-APP.md](docs/ANDROID-APP.md) | Companion app: notification reading, parsing, offline queue, battery |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, signing, keys, fraud cases, privacy |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Targets, limits, scaling, cost, load tests |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md) | RBI, NPCI, DPDP Act, Play Store, UPI-app terms (**get a lawyer**) |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Monitoring, alerts, runbooks, backups, support |
| [docs/TESTING.md](docs/TESTING.md) | Test plan and go-live checklists |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Build steps from core service to product |
| [docs/USE-CASES.md](docs/USE-CASES.md) | Online shops, counters, restaurants, bookings: what each needs |
| [docs/REFERENCES.md](docs/REFERENCES.md) | Official docs and resources |
| [examples/](examples/) | Copy-paste integration code |
| [CLAUDE.md](CLAUDE.md) | Instructions for AI coding sessions in the new repo |

## What a merchant needs

1. A **business UPI ID**. It's free from PhonePe Business, Paytm for Business, Google Pay for Business, BharatPe or their bank.
2. **One Android phone** at the counter with that payment app logged in, internet on, and the AutoConfirm app installed.
3. Their website or app calls the API, or uses the drop-in checkout widget.

## Known limits

- **UPI only:** no cards, net banking or wallets.
- **Not on iPhone:** iOS doesn't let apps read other apps' notifications.
- **Depends on the merchant's phone** being on and online. A manual "mark paid" fallback always works.
- **Payment-app wording changes** can break parsing until the server-side parser rules are updated, which doesn't need an app update.
- **No automatic refunds;** the merchant refunds from their own UPI app.
- **Not for marketplaces** or any case where a third party must trust the confirmation. The merchant controls the phone, so they could fake their own confirmations. That's fine for their own shop, not for escrow.
