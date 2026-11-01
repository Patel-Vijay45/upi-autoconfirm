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

**Usual setup: the restaurant's own website does the ordering; AutoConfirm only does the payment.**
1. The table QR sticker belongs to the restaurant's website (e.g. `restaurant.com/table/4`). The customer orders there.
2. At billing time the website calls `POST /v1/payment_intents` with the final bill (tip already added) and `order_id`.
3. It shows the payment with `checkout.js` (or redirects to `checkout_url`). The customer taps **Pay with Google Pay / PhonePe / Paytm / other UPI app** on the same phone and pays the exact amount shown.
4. The restaurant's phone (AutoConfirm app) sees the payment; the page shows **Paid** and the website gets the `payment_intent.paid` webhook to close the bill.

Nothing restaurant-specific is needed in AutoConfirm for this.

| Need | Feature | Status |
|---|---|---|
| QR on the printed bill | The POS creates the intent when it prints the bill and prints the unique-amount QR (`upi.uri`) on it. | Works with the current API |
| Pay 20–60 min after the bill arrives | Create the intent when the customer taps Pay (15 min is plenty), or use a longer `expires_in` (per-merchant `max_intent_ttl`, up to 3 h). | Works |
| Tip | Simplest: the restaurant's website adds the tip to the bill before creating the intent (works now). Optional later: tip buttons on the hosted checkout page ("+₹20 / +₹50 / custom"). Choosing a tip creates a **replacement** intent with a new unique amount. The original stays matchable until the replacement is paid or expires, so a customer who already paid the original amount is still confirmed. | Planned; design to be finalised |
| Split bill | The POS creates one intent per share (e.g. 3 × ₹310.xx), all with the same `order_id`. The bill is paid when all shares are paid. | Works with the current API |
| Table or counter sticker | Normally the restaurant's own website (setup above). Only for places **without** a website: a fixed sticker opening `/t/:sticker_id` with that table's current bill. A plain static UPI QR (customer types the amount) **can't** auto-confirm. | Website: works. Sticker page: maybe later |

## 4. Bookings and appointments (clinics, salons, events)
- Create the intent when the booking is made; send the checkout link by SMS or WhatsApp from the merchant's own system.
- Use a longer expiry (e.g. 1–3 h) for links sent by message.

## 5. Not suitable
- **Marketplaces, escrow, or anything where a third party must trust the confirmation.** The merchant controls the phone, so they could fake their own confirmations.
- **iPhone-only merchants:** the counter phone must be Android.
- **Card or net-banking payments:** UPI only.
