# Matching: how a phone alert becomes "order paid"

The core rule: **only auto-confirm when exactly one open payment has exactly that amount, at that location, in the time window. Otherwise ask a human.**

## 1. Unique amounts

UPI notifications reliably contain the **amount**. They often **don't** contain the note or reference we sent. So the amount itself is the identifier.

- The merchant asks for `amount = 93000` paise (₹930).
- MerchantDO picks a **random free paise offset** for that base amount at this location:
  - `offset ∈ [1, 99]` paise, so the customer pays at most 99 paise extra.
  - `unique_amount = amount + offset`, e.g. `93007`.
  - Random, not lowest, so the same amount isn't handed out again and again. A late or repeated payment for an old order is then unlikely to land on a new order.
- The pair (location, unique_amount) is **reserved** while the intent is open, and then for a **cool-down** after it closes:
  - Paid or cancelled: reserved until `closed_at + reuse_cooldown`.
  - Expired: reserved until `expires_at + grace_window + reuse_cooldown`.
  - The intent stores this as `reserved_until`, so a restarted DO can rebuild the reserved set from D1.

Why the cool-down matters: without it, ₹930.07 could go to the next ₹930 order seconds after the first one is paid. Then a backup phone's copy of the alert, a customer paying twice, or a "repeat payment" from the UPI app's history would mark the **new** order paid. With the cool-down, those signals find no open intent and go to the inbox as unmatched.

### 1.1 Settings (per merchant)

| Setting | Default | Notes |
|---|---|---|
| `offset_mode` | `add_paise` | Alternatives: `subtract_paise` (customer pays less) or `none` (exact amount; only safe with 1 open payment per amount) |
| `max_offset` | 99 | Lower = smaller extra, fewer parallel slots |
| `intent_ttl` | 15 min | Shown to the customer as a countdown |
| `grace_window` | 30 min | Late notifications can still match recently expired intents |
| `reuse_cooldown` | 60 min | How long a unique amount stays reserved after its intent closes (§1) |
| `auto_confirm_max` | none | Above this amount a match needs one staff tap (§5). `null` = no limit |
| `min_amount` | ₹1 | |
| `max_amount` | ₹1,00,000 | Per-transaction UPI limits vary by bank and app; keep below what most payers can send |

### 1.2 When all 99 offsets for an amount are in use
That means 99 customers at one location are paying the **same** base amount within about an hour (open intents plus the cool-down), which is rare. Then:
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
   │   └─(grace over)──▶ offset released after reuse_cooldown
   │
   ├──(1 matching signal, amount ≤ auto_confirm_max)──▶ PAID (source: auto)
   ├──(1 matching signal, amount > auto_confirm_max)──▶ PENDING + signal in REVIEW ──(staff confirms)──▶ PAID (source: manual)
   ├──(merchant marks paid)────▶ PAID (source: manual)
   └──(customer taps "I have paid")──▶ PENDING + customer_claimed_at  (no state change; just shows "checking")
PAID ──(merchant "undo", within 24 h, audited)──▶ PENDING or CANCELLED
PAID / CANCELLED ──(reuse_cooldown over)──▶ offset released
```

Statuses: `pending`, `paid`, `expired`, `cancelled`. There is no "review" intent status; review lives on the signal (§5).
Flags: `late`, `customer_claimed`, `amount_mismatch` (manual match with a different amount).

## 3. Signal processing (inside MerchantDO, one at a time)

```text
ingest(signal):
  1. Verify the signal belongs to this location's device (done at the edge) and is ≤ 24 h old.
  2. paid_time = signal.posted_at + device.clock_offset, clamped to ≤ received_at.
     (clock_offset = server time − phone time, measured on every heartbeat.)
  3. Dedupe. A signal is a DUPLICATE (no change, duplicate_of = the first signal) when:
     a. Same upload again: fingerprint = sha256(device_id | notification_key_hash | amount | posted_at)
        was seen at this location in the last 48 h. Or
     b. Same payment seen twice: another signal at this location has the same amount, the same
        payer_short (or both empty), the same UTR (when both have one), paid_time within ±2 min,
        is not already the duplicate_of target of a signal from this device,
        AND it came from a different device, or from the same device with the same notification key.
        (Same device + different notification key = a second real payment, not a duplicate.)
  4. candidates = intents at this location where unique_amount == signal.amount
        AND (status == pending OR (status == expired AND received_at − expires_at ≤ grace_window))
        AND created_at − 2 min ≤ paid_time        -- money sent before the order existed can't pay it
     If signal.reference equals an intent id, keep only that intent (its amount must still match).
  5. If a candidate already has a signal waiting in REVIEW → treat as |candidates| > 1.
  6. |candidates| == 1 and amount ≤ auto_confirm_max (or no limit)
        → mark PAID (late flag if expired), store match, set reserved_until, emit events.
     |candidates| == 1 and amount > auto_confirm_max
        → store signal as REVIEW with payment_intent_id = the candidate; intent stays PENDING;
          emit signal.review_required. Staff confirm or reject (§5).
     |candidates| == 0  → store signal as UNMATCHED, emit signal.unmatched.
     |candidates| >  1  → store as AMBIGUOUS, emit signal.unmatched (reason: ambiguous). Never auto-pick.
```

Notes:
- A queued signal sent hours later by an offline phone still uses its real `paid_time`. So it can't pay an order created after the money was actually sent.
- The 2-minute allowance in step 4 covers a phone clock that is slightly off between heartbeats.

### Payment notifications we ignore
- **Outgoing payments** ("You paid ₹…", "Sent ₹…"): the parser rules mark them as `direction: out`.
- **Refunds, cashback, rewards, promos, "request money" reminders.**
- **Amount = 0** or unparseable: logged as `parse_failed` for rule improvement and never used for matching.

## 4. Edge cases

| Case | Behaviour |
|---|---|
| Customer pays **₹930** instead of ₹930.07 (edited amount) | No match, so it goes to the unmatched inbox. The merchant assigns it in one tap ("₹930.00 from Ramesh → order ORD-1042?"). The dashboard suggests the closest pending intent by amount and time. |
| Customer pays **twice** | The amount is still reserved (cool-down), so the second signal finds no open intent and is unmatched. The inbox shows "possible duplicate payment" and the merchant refunds manually. |
| Customer taps **"repeat payment"** in their UPI app hours later | If within the cool-down: unmatched, as above. After it: the amount may belong to a new order, but only an open order with the same base amount can collide, and with random offsets the chance is about 1 in 99 for each such order. Visible in the inbox; reversible with "undo". |
| Customer pays **someone else's** unique amount by chance | Only happens if they type it by hand. That intent gets marked paid, and the real customer's payment later arrives unmatched. Rare; both visible in the inbox; reversible with "undo". |
| A walk-in customer at the counter pays exactly ₹930.07 by coincidence | Same as above. Tiny probability (the amount must match to the paisa within 15 min). |
| Notification arrives **before** the customer taps "I have paid" | Fine; the intent is just marked paid. |
| Notification **never arrives** (phone off or app killed) | The intent expires and the customer page says "Not confirmed yet. Show this screen at the counter." The merchant checks their UPI app or soundbox and marks it paid manually. |
| **Two phones** for one location (backup device) | Both send the same notification. Dedupe rule 3b (same amount, payer, UTR if any, `paid_time` within ±2 min, different device) marks the second copy `duplicate`. Even if dedupe misses it, the amount is in cool-down, so the copy goes to the inbox instead of paying another order. |
| Phone was **offline** and sends a queued signal hours later | Matched by its real `paid_time`. It can only pay an intent that existed when the money was sent, and only within the grace window. Otherwise unmatched. |
| Payment app **changes notification wording** | Parse fails, so it's logged as `parse_failed`. An alert goes to us (operations), and we fix the rule in KV. Devices pull rules every 15 min and on start. |
| Merchant uses **multiple UPI apps** (PhonePe Business + Paytm) | Each app has its own parser rules. All of them feed the same location. |
| Clock skew on phone | Each heartbeat measures `clock_offset` (server time − phone time). `paid_time` = `posted_at` + offset, never later than the server receive time. Grace windows use the server receive time. |
| Partial amount (customer paid less) | Unmatched. Manual. |

## 5. Optional stronger checks (per merchant)
- **Payer name check:** if the checkout collected the customer's name and the notification shows a payer name, require a fuzzy match (≥ 0.6 similarity) for auto-confirm above ₹X. Below that, still auto-confirm but flag it.
- **Two-source confirmation** for high value: require the app notification **and** the bank SMS within 5 min. Only if the merchant enables SMS reading (see ANDROID-APP.md for Play policy issues).
- **Staff confirm above ₹X** (`auto_confirm_max`): this is the main protection if a phone's device secret is ever stolen (SECURITY T3).
  - A signal that would auto-match an intent above the limit is stored with status `review`, linked to that intent as a suggestion.
  - The intent stays `pending`, so its amount stays reserved, and the customer sees "Checking payment…".
  - The inbox and the `signal.review_required` webhook show "₹4,500.12 from Ramesh P → order ORD-1043? Confirm / Reject".
  - **Confirm** uses the normal assign flow: the intent becomes `paid` (source `manual`, audited, `late` if it expired meanwhile).
  - **Reject** sets the signal to `unmatched`, and the intent carries on as normal.
  - There is no extra intent status, so webhooks, fulfilment rules and the state machine stay the same.

## 6. Customer experience on the checkout page
1. It shows the amount **₹930.07** in large digits, with a small note: "+7 paise helps us confirm your payment automatically".
2. Buttons: **Pay with Google Pay**, **PhonePe**, **Paytm**, **Other UPI app**, plus a QR code (for paying from another phone).
3. After returning to the page: **"I have paid"**, which shows "Checking payment… ⏳" and a live connection.
4. **Paid:** "Payment received ✓", then a redirect to the merchant's `return_url` or the merchant's own success UI.
5. If nothing arrives after 2 min: "Still checking. If money was deducted, show this screen at the counter / contact the shop." Never tell the customer to pay again.
