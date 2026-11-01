# User manual

How to set up and use AutoConfirm, from nothing to taking real payments. Written for phone-first use; no coding needed except in Part G (connecting a website).

| Part | Who | Time |
|---|---|---|
| [A. Set up the service](#a-set-up-the-service-once) | You (the operator) | ~30 min, once |
| [B. Create a shop](#b-create-a-shop) | Operator | 2 min per shop |
| [C. First login (shop owner)](#c-first-login-shop-owner) | Shop owner | 3 min |
| [D. Set up the counter phone](#d-set-up-the-counter-phone) | Shop owner | 10 min per phone |
| [E. Test payment](#e-test-payment-end-to-end) | Shop owner | 2 min |
| [F. Daily use](#f-daily-use) | Owner and staff | — |
| [G. Connect a website or app](#g-connect-a-website-or-app) | Developer | 1–2 h |
| [H. Team and security](#h-team-and-security) | Owner, operator | — |
| [I. Troubleshooting](#i-troubleshooting) | Everyone | — |

**What AutoConfirm is:** customers pay with any UPI app straight into the shop's own UPI ID. A phone at the counter sees "… paid you ₹…", and AutoConfirm marks the right order **Paid** within seconds. No gateway, no % fee, and the money never passes through AutoConfirm.

---

## A. Set up the service (once)

You need a GitHub account (the code is in `Patel-Vijay45/upi-autoconfirm`) and a free Cloudflare account. Full detail with screenshots-level steps: [DEPLOY.md](DEPLOY.md). Short version:

1. **Cloudflare account:** sign up at dash.cloudflare.com/sign-up and verify the email. You don't need to create any application; the first deploy sets up your `workers.dev` address.
2. **Account ID:** the 32-character code in the browser address after `dash.cloudflare.com/`.
3. **API token:** profile icon → **My Profile → API Tokens → Create Token** → **"Edit Cloudflare Workers"** template → add **Account · D1 · Edit** and **Account · Queues · Edit** → Create → copy it. Never paste it in chats or files.
4. **Operator password:** make a random password of **at least 32 characters** (40 is better) in your password manager and **save it**. It lets you create shops.
5. **GitHub secrets:** repo **Settings → Environments** → create `staging` and `production`. In each, add the secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AUTOCONFIRM_ADMIN_TOKEN` (the operator password).
6. **Deploy:** merging into `main` deploys **staging** automatically. For **production**: **Actions → Deploy → Run workflow** (branch `main`). Wait for green ticks.
7. **Your addresses** (your subdomain instead of `ddumy209`):
   - Dashboard: `https://autoconfirm-dashboard.ddumy209.workers.dev`
   - API: `https://autoconfirm-api.ddumy209.workers.dev`
   - Staging adds `-staging` to both names. Use staging to try things, production for real shops.

Optional: on a public repo, **Settings → Environments → production → Required reviewers** (yourself) adds an approval step.

Everything runs on Cloudflare's **free plan** (100,000 requests/day; about 2,000 webhooks/day). See "Costs" in DEPLOY.md.

---

## B. Create a shop

1. Open `https://<dashboard>/operator` (any browser, including a phone).
2. Enter your **operator password**, the **shop name**, and the **owner's email** (their dashboard login). Tap **Create shop**.
3. The page shows:
   - The owner's **setup link**. It works once and for 72 hours. Send it to the owner (or open it yourself).
   - The shop's **API keys**, shown only now. Only needed if a website will connect (Part G). New keys can be made later in the dashboard.
4. To add more people to an existing shop: the same page, "Invite someone to an existing shop" (needs the shop ID `mer_…`).

Wrong operator passwords are blocked after 10 tries in 15 minutes.

---

## C. First login (shop owner)

1. Open the **setup link**.
2. Choose a password (at least 10 characters) and type it twice.
3. Install an authenticator app (Google Authenticator, Microsoft Authenticator…), tap **+**, and **scan the QR** on the page. Can't scan? Type the key shown under it.
4. Enter the 6-digit code from the app → **Create my account**. You're in.

Next logins: email + password + the current 6-digit code. Owners and admins always need the code; staff can skip it.

The top bar has a **Live data / Test data** switch. Use **Live data** for real payments. Test data is for trying the system with the simulator or test keys; a purple bar shows when you're in test mode.

---

## D. Set up the counter phone

The counter phone is an **Android** phone that has the shop's **payment app** (the one that says "… paid you ₹…" when money arrives) logged in to the shop's UPI ID. iPhones can't be used.

### D1. Add the counter in the dashboard
**Counters & phones → Add a counter**: name (e.g. "Counter 1"), the shop's **UPI ID** (e.g. `shop@okaxis`), and the **name customers see**.

Most shops have **one UPI ID**, so they need **one counter**. Enter the UPI ID once, when you add the counter. A counter means "one UPI ID", not "one desk": if several desks or a backup phone use the same UPI ID, pair **more phones to the same counter** (the same payment is then counted once). Add a second counter only for a different UPI ID (the dashboard refuses the same UPI ID twice).

### D2. Install the AutoConfirm app
1. Open the APK file on the phone.
2. If Android says the source isn't allowed: **Settings → Allow from this source**, then back → **Install**.
3. If **Play Protect** blocks it ("blocked to protect your device"):
   - tap **More details → Install anyway**, or if there's no such button:
   - **Play Store → profile picture → Play Protect → ⚙ → turn off "Scan apps with Play Protect"**, install, then turn it back **on**.

   This happens because the app reads notifications and isn't from the Play Store yet.

### D3. Pair it
1. Dashboard: on the counter → **Add phone → Create pairing code**. A QR and an `autoconfirm://pair?…` link appear (valid 10 minutes, once).
2. On the counter phone: scan the QR with the **camera** (or Google Lens) and tap the link. If the dashboard is open on the same phone, copy the link and paste it into the app.
3. Tap **Pair this phone**.

### D4. Finish the checklist in the app
| Item | How |
|---|---|
| **Notification access** | First, Android blocks it for apps from outside the Play Store: **Settings → Apps → See all apps → AutoConfirm → ⋮ (top right) → Allow restricted settings** (confirm with PIN). Then in the app tap **Turn on**, find **AutoConfirm** (green tick icon; not "Android Auto") and switch it on. |
| **Battery** | Tap **Fix** → on "App battery usage" tap the **words "Allow background usage"** → choose **Unrestricted**. |
| **Autostart** | Only on Xiaomi, Oppo, Vivo, Realme: **Open settings** → allow autostart. |
| **Payment-app rules loaded** | Should show ✓ with a version. If ✗, tap **Retry** (needs internet). |

The top of the app should say **Online**. In the dashboard, the phone shows **Online** too.

Keep the phone charged, on internet, and don't swipe AutoConfirm away from recent apps. If it goes offline, the dashboard shows it.

### D5. Removing a phone (stays in sync both ways)
- **Dashboard → Counters & phones → Remove:** the server stops accepting that phone at once. If the app is open, it shows "This phone was removed, pair again" within 30 seconds; otherwise as soon as it's opened.
- **App → Unpair this phone:** the app tells the server, and the Counters & phones page shows the phone as removed within 15 seconds (it refreshes itself). If the phone is offline at that moment, also press **Remove** in the dashboard.

---

## E. Test payment (end to end)

1. Dashboard (**Live data**) → **Payments → + New payment** → amount **1** → **Create and show QR**. The page shows an amount like **₹1.37** and a QR.
2. From **another phone**, scan the QR with Google Pay (or any UPI app) and pay **exactly** that amount.
3. Within a few seconds the dashboard page turns into a green **✓ Paid**, and the app's "Today" list shows **Order paid ✓**.

If instead the payment lands in the **Inbox**, see [Troubleshooting](#i-troubleshooting).

Note: right now the app reads **Google Pay "paid you"** alerts and **bank credit SMS** (checked with IDFC FIRST; other big banks are on the list but need a real sample). If a payment isn't picked up, screenshot the "money received" notification or SMS and send it to whoever maintains the rules (see DEVELOPMENT.md → "Support a new payment app").

---

## F. Daily use

### Taking a payment at the counter
**+ New payment** → amount (and an optional note like "Table 4") → show the QR to the customer → the page turns **✓ Paid** by itself, usually within a second or two of the phone seeing the payment (no refresh needed). The payments list also refreshes itself while something is waiting. The customer must pay the **exact** amount shown, including the paise; the extra paise is how the system knows which order it is.

### Payments list
Filter by **Waiting / Paid / Expired / Cancelled**. Open a payment to:
- **Mark paid**: only after checking the phone or soundbox; it's logged.
- **Cancel**: the customer left.
- **Undo paid** (within 24 h): if it was marked by mistake. The money signal goes back to the inbox.

A waiting payment expires after 15 minutes (you can change this in Settings). Late payments are still matched for 30 minutes after expiry.

### Inbox (check it a few times a day)
Money the phone saw that couldn't be matched automatically:

| Status | Meaning | What to do |
|---|---|---|
| **Unmatched** | No open order with that exact amount (e.g. the customer typed ₹930 instead of ₹930.37), or a walk-in customer | Tap **Match** on the right order (suggestions are shown), or **Ignore** with a reason |
| **Ambiguous** | More than one possible order | Ask the customer, then **Match** the right one |
| **Needs review** | Amount above your auto-confirm limit | Check the phone/soundbox → **Confirm payment**, or **Not this order** |

Never hand over goods based on a customer's screenshot. Wait for **✓ Paid**, or check the phone/soundbox yourself.

### Reports
**Reports** → pick dates → daily totals (Indian time), how many were confirmed automatically, and what's still in the inbox. **Download CSV** for your accountant. "Received" includes the identifying paise; it should match your bank statement.

### Settings (owner/admin)
- **Auto-confirm limit (₹)**: payments above it need one staff tap in the inbox. Recommended for expensive items.
- **Payment request expiry**: default 15 min (restaurants may want 60).
- **Longest expiry** a website may ask for: up to 180 min.
- **Team** and **Activity log**: see Part H.

---

## G. Connect a website or app

For developers. Full guide: [INTEGRATION.md](INTEGRATION.md); API reference: [API.md](API.md).

1. **Keys:** dashboard → **Developers → Create key**. A **secret key** (`sk_live_…`) is for your server only; a **publishable key** (`pk_live_…`) is for the browser widget. Use `sk_test_`/`pk_test_` while building.
2. **Create a payment** from your server when the customer checks out:
   ```bash
   curl -X POST https://<api>/v1/payment_intents \
     -H "Authorization: Bearer sk_live_…" -H "Idempotency-Key: order-1042" \
     -H "Content-Type: application/json" \
     -d '{"amount": 93000, "order_id": "ORD-1042", "return_url": "https://yoursite.com/order/1042"}'
   ```
   `amount` is in **paise** (93000 = ₹930).
3. **Show it:** redirect the customer to the returned `checkout_url`, **or** use the widget (`<script src="https://<api>/v1/checkout.js">` + `AutoConfirm.open({key:'pk_live_…', intent:'pi_…', onPaid})`), **or** build your own page from `upi.apps.*`, `upi.qr_svg` and `display_amount`.
4. **Webhook:** **Developers → Webhooks → Add endpoint** (HTTPS URL). Copy the signing secret (shown once). On `payment_intent.paid`, verify the `AutoConfirm-Signature` header, then mark your order paid. For Node: `@autoconfirm/node` (`ac.webhooks.constructEvent(rawBody, header, secret)`).
5. Before handing over goods, you can double-check with `GET /v1/payment_intents/:id` → `status: "paid"`.

---

## H. Team and security

- **Invite people:** Settings → Team → email + role → send them the setup link (72 h, once).
  - **Staff:** payments and inbox only.
  - **Developer:** keys and webhooks (test keys only).
  - **Admin:** everything except inviting owners.
  - **Owner:** everything.
- **Someone leaves:** Settings → Team → **Deactivate** (logs them out immediately).
- **Forgot password:** an owner or admin invites them again (password reset isn't built yet). If the only owner is locked out, the operator creates an invite from `/operator` (role owner).
- **Lost or stolen counter phone:** Counters & phones → **Remove** next to the phone (it stops confirming immediately), then change the payment app's PIN.
- **Leaked API key:** Developers → **Revoke**, create a new one, update your website.
- **Operator password lost:** create a new one and update `AUTOCONFIRM_ADMIN_TOKEN` in both GitHub environments, then **Run workflow**. This doesn't affect shops, phones or logins.
- **Cloudflare token leaked:** Cloudflare → API Tokens → ⋯ → **Roll**, then update `CLOUDFLARE_API_TOKEN` in GitHub.
- Never share secrets in chat, email or files. They belong only in GitHub secrets or a password manager.

---

## I. Troubleshooting

| Problem | Fix |
|---|---|
| **Play Protect blocks the install** | D2: "Install anyway", or pause Play Protect while installing. |
| **"App was denied access" for notifications** | D4: Settings → Apps → AutoConfirm → ⋮ → **Allow restricted settings**, then turn access on for **AutoConfirm** (not Android Auto). |
| **App says Offline** | Check internet; notification access on; battery **Unrestricted**; open the app once. Restarting the phone also works; the app restarts itself. |
| **"Payment-app rules loaded" ✗** | Tap **Retry**. If it stays ✗, the service was deployed without rules: run the Deploy workflow. |
| **Payment made but not confirmed** | 1) Did the customer pay the **exact** amount? If not, it's in the **Inbox** → Match. 2) Is the phone Online? 3) Does the app's "Today" list show the payment? If not, the payment app's wording isn't in the rules yet; send a screenshot. 4) Is the payment app's notification turned on and not silenced? |
| **Shows in Inbox as "Needs review"** | Amount is above your auto-confirm limit; confirm it after checking. |
| **Customer paid twice** | The second payment appears **Unmatched** in the inbox ("possible duplicate"). Refund it from your UPI app and **Ignore** it. |
| **Pairing failed** | Codes last 10 min and work once: create a new one. Make sure the phone has internet. |
| **Setup link doesn't work** | It expired (72 h) or was used. Ask for a new invite. |
| **"Too many failed logins"** | Wait 15 minutes. |
| **Lost authenticator phone** | Ask an owner/admin (or the operator) to deactivate and re-invite you. |
| **Deploy failed in GitHub Actions** | Open the failed run → read the last red step. Common: wrong/rolled Cloudflare token in GitHub secrets; Cloudflare rate limit (just re-run). |
| **Cloudflare error 1027** | The free daily request limit is used up; it resets daily. Consider Workers Paid ($5/month) if it happens often. |
