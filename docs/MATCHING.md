# Matching: how a phone alert becomes "order paid"

The core rule: **only auto-confirm when exactly one open payment has exactly that amount, at that location, in the time window. Otherwise ask a human.**

## 1. Unique amounts

UPI notifications reliably contain the **amount**. They often **don't** contain the note or reference we sent. So the amount itself is the identifier.

- The merchant asks for `amount = 93000` paise (₹930).
- MerchantDO picks the **lowest free paise offset** for that base amount among this location's active intents:
  - `offset ∈ [1, 99]` paise, so the customer pays at most 99 paise extra.
  - `unique_amount = amount + offset`, e.g. `93007`.
- The pair (location, unique_amount) is **reserved** until the intent is paid, cancelled, or expired plus the grace window.

### 1.1 Settings (per merchant)

| Setting | Default | Notes |
|---|---|---|
| `offset_mode` | `add_paise` | Alternatives: `subtract_paise` (customer pays less) or `none` (exact amount; only safe with 1 open payment per amount) |
| `max_offset` | 99 | Lower = smaller extra, fewer parallel slots |
| `intent_ttl` | 15 min | Shown to the customer as a countdown |
| `grace_window` | 30 min | Late notifications can still match recently expired intents |
| `min_amount` | ₹1 | |
| `max_amount` | ₹1,00,000 | Per-transaction UPI limits vary by bank and app; keep below what most payers can send |

### 1.2 When all 99 offsets for an amount are in use
That means 99 customers at one location are paying the **same** base amount at once, which is very rare. Then:
1. Try the next rupee band: `amount + 100 + offset`. Allowed only if the merchant enabled `allow_rupee_bump`; default off.
2. Otherwise return `409 slots_exhausted`. The merchant site shows "Pay at counter".

### 1.3 Why not use the UPI note or transaction reference?
- We **do** send `tn` (note) = the order label and `tr` (reference) = the intent id in the UPI link. Some bank SMS and app notifications show them.
- If a parser extracts a reference that equals an intent id, that's a **stronger match**: it wins and ignores the amount, but only after checking that the amount is also right.
- Amount matching remains the default because note and reference are often missing from notifications.

## 2. State machine

```
            create
              │
              ▼
   ┌───── PENDING ──────┐
   │   │  expires_at    │ cancel (merchant)
   │   ▼                ▼
   │ EXPIRED ──(late signal within grace)──▶ PAID (late=true)
   │   │
   │   └─(grace over)──▶ offset released
   │
   ├──(1 matching signal)──────▶ PAID (source: auto)
   ├──(merchant marks paid)────▶ PAID (source: manual)
   └──(customer taps "I have paid")──▶ PENDING + customer_claimed_at  (no state change; just shows "checking")
PAID ──(merchant "undo", within 24 h, audited)──▶ PENDING or CANCELLED
```

Statuses: `pending`, `paid`, `expired`, `cancelled`.
Flags: `late`, `customer_claimed`, `amount_mismatch` (manual match with a different amount).

## 3. Signal processing (inside MerchantDO, one at a time)

```text
ingest(signal):
  1. Verify the signal belongs to this location's device (done at the edge) and is ≤ 24 h old.
  2. Dedupe: fingerprint = sha256(device_id | notification_key | amount | posted_at_rounded_to_10s)
     and also sha256(app | amount | payer | utr) when a UTR is present.
     Seen in last 48 h → return "duplicate" (no change).
  3. If signal.reference matches an intent id → candidate = that intent (check amount equals unique_amount).
  4. Else candidates = intents where unique_amount == signal.amount
        AND status in (pending) OR (expired AND now - expires_at ≤ grace_window).
  5. |candidates| == 1  → mark PAID (late flag if expired), store match, release offset, emit events.
     |candidates| == 0  → store signal as UNMATCHED, emit signal.unmatched.
     |candidates| >  1  → store as AMBIGUOUS, emit signal.unmatched (reason: ambiguous). Never auto-pick.
```

### Payment notifications we ignore
- **Outgoing payments** ("You paid ₹…", "Sent ₹…"): the parser rules mark them as `direction: out`.
- **Refunds, cashback, rewards, promos, "request money" reminders.**
- **Amount = 0** or unparseable: logged as `parse_failed` for rule improvement and never used for matching.

## 4. Edge cases

| Case | Behaviour |
|---|---|
| Customer pays **₹930** instead of ₹930.07 (edited amount) | No match, so it goes to the unmatched inbox. The merchant assigns it in one tap ("₹930.00 from Ramesh → order A-31-7?"). The dashboard suggests the closest pending intent by amount and time. |
| Customer pays **twice** | Second signal: no pending intent with that amount, so it's unmatched. The inbox shows "possible duplicate payment" and the merchant refunds manually. |
| Customer pays **someone else's** unique amount by chance | Only happens if they type it by hand. That intent gets marked paid, and the real customer's payment later arrives unmatched. Rare; both visible in the inbox; reversible with "undo". |
| A walk-in customer at the counter pays exactly ₹930.07 by coincidence | Same as above. Tiny probability (the amount must match to the paisa within 15 min). |
| Notification arrives **before** the customer taps "I have paid" | Fine; the intent is just marked paid. |
| Notification **never arrives** (phone off or app killed) | The intent expires and the customer page says "Not confirmed yet. Show this screen at the counter." The merchant checks their UPI app or soundbox and marks it paid manually. |
| **Two phones** for one location (backup device) | Both send the same notification. Dedupe by (amount, payer, UTR or posted_at window) ensures only one match. |
| Payment app **changes notification wording** | Parse fails, so it's logged as `parse_failed`. An alert goes to us (operations), and we fix the rule in KV. Devices pull rules every 15 min and on start. |
| Merchant uses **multiple UPI apps** (PhonePe Business + Paytm) | Each app has its own parser rules. All of them feed the same location. |
| Clock skew on phone | We use the server receive time for windows, and the phone's `posted_at` only for ordering and dedupe. |
| Partial amount (customer paid less) | Unmatched. Manual. |

## 5. Optional stronger checks (per merchant)
- **Payer name check:** if the checkout collected the customer's name and the notification shows a payer name, require a fuzzy match (≥ 0.6 similarity) for auto-confirm above ₹X. Below that, still auto-confirm but flag it.
- **Two-source confirmation** for high value: require the app notification **and** the bank SMS within 5 min. Only if the merchant enables SMS reading (see ANDROID-APP.md for Play policy issues).
- **Manual-only above ₹X:** auto-match marks the intent `paid_pending_review`, and staff confirm.

## 6. Customer experience on the checkout page
1. It shows the amount **₹930.07** in large digits, with a small note: "+7 paise helps us confirm your payment automatically".
2. Buttons: **Pay with Google Pay**, **PhonePe**, **Paytm**, **Other UPI app**, plus a QR code (for paying from another phone).
3. After returning to the page: **"I have paid"**, which shows "Checking payment… ⏳" and a live connection.
4. **Paid:** "Payment received ✓", then a redirect to the merchant's `return_url` or the merchant's own success UI.
5. If nothing arrives after 2 min: "Still checking. If money was deducted, show this screen at the counter / contact the shop." Never tell the customer to pay again.
