# Performance, scale and cost

## 1. Targets (SLOs)
| Metric | Target |
|---|---|
| Notification on phone → `payment_intent.paid` webhook sent | p50 < 1.5 s, **p95 < 3 s** (when the phone is online) |
| `POST /v1/payment_intents` | p95 < 150 ms from India |
| Checkout page first load (4G, mid-range Android) | < 1.5 s; JS < 20 KB gzipped |
| Live status push after match | < 500 ms |
| API availability | 99.9% monthly |
| Wrong auto-matches | **0** (any occurrence is a P1 incident) |

## 2. Where time goes
```
Payment app shows notification  (bank + app: usually 1–5 s after the customer taps Pay; outside our control)
 → listener callback            (~10–100 ms)
 → HTTPS to nearest Cloudflare PoP (~30–150 ms on Indian 4G)
 → verify HMAC + DO ingest/match (~5–20 ms)
 → D1 write + queue enqueue     (~20–60 ms)
 → live push to checkout page   (~50 ms)
 → webhook delivery             (depends on the merchant's server)
```

## 3. Scale model
- **Matching load is per location.** A busy stall at peak handles about 2–5 payments per minute; even 100 per minute is trivial for one Durable Object, which handles hundreds of requests per second.
- **Total load** grows with merchants, and the work is spread across one object per location, so it scales horizontally without coordination.
- **D1:**
  - Start with one database.
  - Each paid payment writes about 5–8 rows (intent, signal, event, delivery, audit), roughly 15–25 rows written including indexes.
  - Shard by merchant hash into N databases when a database nears **~8 GB** or sustained writes get high. The router maps `merchant_id → db` in KV.
- **Queues:** webhook delivery is parallel per endpoint, with backpressure per merchant so one slow merchant server can't delay others.
- **Hot paths avoid D1 reads:** the Durable Object keeps the active intents in its own storage and memory. D1 is written asynchronously after the match, with retries and idempotent upserts.

### 3.1 Capacity example
10,000 merchants × 200 payments/day = 2 M payments/day (about 23/s on average, about 200/s peak).
- Workers: about 2 M creates + 2 M signals + 4 M status/live + 2 M webhooks, roughly 10 M requests/day (~300 M/month).
- Durable Objects: about 4 M requests/day plus WebSocket messages.
- D1: about 40 M rows written/day. Shard into ~4–8 databases.
- This is well within Cloudflare's paid plans. See §4 for cost.

## 4. Cost (Cloudflare list prices change; recheck before quoting)
| Scale | Rough monthly infra cost |
|---|---|
| Pilot (1–10 merchants) | Free tier or $5 Workers Paid |
| 1,000 merchants | ~$5–30 |
| 10,000 merchants | ~$100–400 (mostly requests and D1 writes) |

Pricing suggestion: a flat **₹199–499 per location per month**. This beats any percentage fee for the merchant and covers costs at any scale.

## 5. Front-end performance (checkout and widget)
- No framework in the widget: vanilla TypeScript, < 15 KB gzipped, loaded `defer`.
- The QR is generated server-side as SVG (no QR library in the browser).
- Fonts are system fonts; all CSS inline.
- The live connection is opened only after the customer taps a pay button.
- Back/forward cache friendly: re-check status on `pageshow` (customers come back from the UPI app).

## 6. Load and soak tests (before launch)
| Test | Pass criteria |
|---|---|
| 500 intents/s across 1,000 merchants for 10 min | p95 create < 200 ms, 0 errors |
| 1 location: 200 intents with the **same base amount** at once | 99 get unique offsets, then the rest get a correct `409 slots_exhausted`, and no duplicates |
| Signal storm: 100 signals/s to one location | Each matched exactly once; dedupe correct |
| Duplicate signals (same notification sent 5×, 2 devices) | Exactly 1 match |
| Webhook endpoint down for 1 h | All events delivered after recovery, in order per intent, no loss |
| Durable Object eviction or restart mid-burst | No lost or duplicate matches (state persisted before ack) |
| 24 h soak on a real phone (Xiaomi, Samsung, Vivo) | Heartbeat never missing > 10 min with the checklist done |
