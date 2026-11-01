# Design decisions

Why AutoConfirm is built the way it is. Read before changing one of these; if you change one, add a new entry (don't rewrite history).

Format: **Decision** — why — consequences.

## Product

1. **Confirm payments to the merchant's own UPI ID; never touch money.**
   Payment gateways charge ~2 % + GST and refuse some businesses. Not holding funds also keeps us out of RBI payment-aggregator licensing (see COMPLIANCE.md).
   → No refunds, payouts or cards. Refunds happen in the merchant's UPI app.

2. **Identify a payment by a unique paise amount (₹930 → ₹930.07).**
   UPI notifications reliably show the amount; they often don't show our note or reference.
   → At most 99 open payments per base amount per counter; the customer pays up to 99 paise extra.

3. **Read the merchant's own "money received" notifications with an Android app.**
   No bank API is needed and it works with any bank or app. iOS can't read other apps' notifications.
   → Needs an Android phone online at the counter, and parser rules per payment app.

4. **A generic, reusable service; every project is just a merchant.**
   The owner wants to reuse it for many projects (shops, restaurants, bookings).
   → No project-specific code. Use-case features go through the public API (USE-CASES.md).

## Matching safety

5. **Auto-confirm only when exactly one open payment has exactly that amount; otherwise the inbox.**
   A wrong "paid" means goods given away. Humans resolve unclear cases in one tap.

6. **Random offsets plus a reuse cool-down (60 min after an intent closes).**
   Found in the first review: reusing ₹930.07 right after it was paid would let a backup phone's copy, a double payment or a "repeat payment" pay the *next* order.

7. **A signal can't pay an intent created after the money was sent (`paid_time`, corrected by the phone's clock offset).**
   Phones queue signals while offline. A late queued signal must not pay a newer order with the same amount.

8. **"Review" lives on the signal, not as a new intent status.**
   A `paid_pending_review` intent status would make every consumer (webhooks, fulfilment, the state machine) handle a half-paid state. Instead the intent stays `pending` and its amount stays reserved.

9. **The engine is pure TypeScript with property tests.**
   The safety rules are the product. Pure code can be tested with thousands of random sequences (including simulated restarts) and mutation-checked.

## Architecture

10. **Cloudflare Workers + D1 + Durable Objects + Queues + KV.**
    No servers, edge locations in India, and the free plan is enough to start.

11. **One Durable Object per counter and mode (`merchant:location:live|test`).**
    A DO runs one request at a time, so two signals can't grab the same payment and one amount can't be handed out twice, all without database locks. It also holds the live WebSockets.

12. **Outbox: the DO saves its state and "what to write to D1 / the queue" in one transaction.**
    D1 or the queue may fail briefly; nothing may be lost or done twice. An alarm retries.

13. **Test and live are separate all the way down** (keys, phones, signals, events, webhooks, DOs).
    The device simulator or a test phone must never confirm a real payment.

14. **The hosted page and the widget share one template; the server draws the QR.**
    The markup exists once; browsers need no QR library; `checkout.js` stays ~5 KB (limit 15 KB).

15. **Live status over WebSockets (DO hibernation API) with polling as a fallback.**
    The customer sees "paid" within a second. Hibernation means idle connections cost nothing. Server-Sent Events were dropped as redundant.

16. **The dashboard is a thin SvelteKit app that calls the API through a service binding.**
    All tenancy and role rules live in one tested place (the API). The service binding keeps traffic internal and forwards the real client IP for login throttling.
    → `PUBLIC_API_URL` must be set on the API (behind the binding it can't see its own public address).

17. **Passwords are hashed inside a Durable Object (`PasswordDO`).**
    The free plan gives normal requests 10 ms of CPU; PBKDF2 at 100k iterations takes ~13 ms. DOs get 30 s.

18. **Owners and admins need an authenticator code; there's no email sending.**
    Email needs a paid service. One-time invite links (72 h) replace "email me a password". Password reset = re-invite.

19. **An operator token (`ADMIN_TOKEN`) creates shops, via `/operator` or `tools/admin.mjs`.**
    There's no self-serve signup yet. The page works from a phone; wrong tokens are throttled.

## Android

20. **Never request SMS or Accessibility permissions; send only parsed fields.**
    Play Store policy and privacy. Bank SMS can still be read as a notification later, if needed.

21. **Parser rules come from the server (`rules/parser-rules.json` → KV on deploy).**
    When a payment app changes its wording, we fix a JSON file instead of shipping an app update. The rules are versioned in git and tested against real captured notifications.

22. **Bank SMS is not read for now.**
    With both the app alert and the SMS, every payment would be reported twice (the second copy would land in the inbox). Revisit with cross-app dedupe.

23. **Pairing by QR opened in the system camera (`autoconfirm://pair?…`).**
    No camera permission and no scanning library; pasting the link also works.

24. **Sideloaded APK for now; Play Store later.**
    It's fast to iterate. The cost: Play Protect and "restricted settings" warnings on install (USER-MANUAL D2/D4).

## Operations

25. **Push to `main` deploys staging; production only via "Run workflow".**
    Works on every GitHub plan without paid "required reviewers".

26. **The deploy script creates resources and keys and never replaces existing encryption keys.**
    Replacing `DEVICE_KEY`/`WEBHOOK_KEY`/`MFA_KEY` would make stored secrets unreadable.

27. **Migrations are additive only; never edit an applied one.**
    Older Worker versions keep working with the newer schema, so rollbacks are safe.
