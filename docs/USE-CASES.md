# Use cases

AutoConfirm is generic. The same API, webhooks and checkout page serve every kind of business. This page lists common setups and the features each one needs. Nothing here is tied to a specific project.

Rule for every use case: **the customer only pays the amount shown.** No typing a UTR, no screenshots, no extra steps.

## 1. Online shop (website or app)
- The site creates a payment intent when the customer checks out, then shows the hosted checkout page or the `checkout.js` widget.
- The site fulfils the order on the `payment_intent.paid` webhook, after re-checking with `GET /v1/payment_intents/:id`.
- Default expiry (15 min) fits.

## 2. Shop counter (walk-in)
- Staff enter the total in their POS or a simple web page, which creates the intent and shows the QR on a screen facing the customer.
- The counter phone runs the AutoConfirm app. The staff screen turns green on ✓ Paid.
- Several counters can share one UPI ID: that's one **location** with several phones.

## 3. Restaurant / café
Customers often pay after eating, sometimes with a tip, sometimes splitting the bill.

| Need | Feature | Status |
|---|---|---|
| QR on the printed bill | The POS creates the intent when it prints the bill and prints the unique-amount QR (`upi.uri`) on it. | Works with the current API |
| Pay 20–60 min after the bill arrives | Per-merchant `max_intent_ttl` (up to 3 h). Longer expiry holds amounts longer, which is fine at restaurant volumes. | Planned (Step 5) |
| Tip | Tip buttons on the checkout page ("+₹20 / +₹50 / custom"). Choosing a tip creates a **replacement** intent with a new unique amount. The original stays matchable until the replacement is paid or expires, so a customer who already paid the original amount is still confirmed. | Planned; design to be finalised |
| Split bill | The POS creates one intent per share (e.g. 3 × ₹310.xx), all with the same `order_id`. The bill is paid when all shares are paid. | Works with the current API |
| Table or counter sticker | A fixed QR sticker opens `/t/:sticker_id`, which shows that table's current open bill with its unique amount. A plain static UPI QR (customer types the amount) **can't** auto-confirm. | Planned (Step 5) |

## 4. Bookings and appointments (clinics, salons, events)
- Create the intent when the booking is made; send the checkout link by SMS or WhatsApp from the merchant's own system.
- Use a longer expiry (e.g. 1–3 h) for links sent by message.

## 5. Not suitable
- **Marketplaces, escrow, or anything where a third party must trust the confirmation.** The merchant controls the phone, so they could fake their own confirmations.
- **iPhone-only merchants:** the counter phone must be Android.
- **Card or net-banking payments:** UPI only.
