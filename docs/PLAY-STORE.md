# Publishing the Android app on Google Play

Everything to get the AutoConfirm app onto Google Play, step by step, with copy-paste answers for every Play Console form. Most steps work from a phone browser (in Chrome, tick **Desktop site** for Play Console).

**Short version:**
1. Make a Play developer account.
2. Add 3 secrets and 2–3 variables in GitHub.
3. Run **Deploy** and **Android release**.
4. Create the app and paste the answers below.
5. Run internal testing, then closed testing (12 testers × 14 days for a new personal account).
6. Apply for production.

---

## 0. Is the app ready? (policy checklist)

| Google Play requirement | Status |
|---|---|
| Target API level (Android 16 / API 36) | ✅ `targetSdk = 36` |
| 16 KB memory pages (Android 15+ devices) | ✅ the only native library is 16 KB-aligned (checked) |
| App Bundle (.aab), signed with an upload key | ✅ "Android release" workflow (step 4) |
| No restricted permissions (SMS, Call log, Accessibility, location, all-files, battery-exemption request) | ✅ only Internet, network state, start at boot, notifications |
| Prominent disclosure **before** notification access, with an explicit "Agree" | ✅ says what is read (payment apps + bank SMS alerts), what is sent, and what is never sent. Text in §9. |
| Privacy policy: link in the store **and** inside the app | ✅ public page `/privacy` on the dashboard; "Privacy policy" link in the app |
| Privacy policy matches what the app does; data deletion explained | ✅ incl. retention, actually enforced by a daily clean-up job |
| Data safety form | ✅ answers in §6.5 |
| Reviewers can use the app without an account | ✅ **demo mode**: "No shop yet? See how it works" on the first screen |
| No misleading claims | ✅ described as "UPI payment confirmation", not a payment gateway; not affiliated with payment apps or banks |
| Not for children | ✅ target audience 18+ |
| Ads | ✅ none |

**Main review risk.** The app reads bank "credited" SMS **notifications** (not the SMS inbox) through notification access. That is allowed: it needs no SMS permission, and it is disclosed and core to the app. But a reviewer may ask about it. Answer with the text in §9, and keep a 30-second screen recording ready (§8). If Google still objects, the fallback is to remove the messaging apps from `rules/parser-rules.json` (server-side, no app update). Payment-app alerts keep working.

---

## 1. Google Play developer account (one time)

1. Go to <https://play.google.com/console/signup> and sign in with the Google account that will own the app.
2. Choose **Yourself** (personal account) unless you have a registered business with a D-U-N-S number (then **An organization**).
3. Pay the one-time **US$25** fee and finish identity verification (government ID; can take a few days).
4. Verify a phone number and email when asked.

> **Personal accounts created after November 2023:** before you can publish to everyone, you must run a **closed test with at least 12 testers who stay opted in for 14 days in a row**. Organization accounts skip this. Start recruiting testers early (friends, family, other shop owners with an Android phone and a Gmail address).

---

## 2. GitHub settings (one time)

Open the repo on GitHub → **Settings** → **Environments** → **production**.

### 2a. Upload key (3 secrets)
Google Play signs the app with its own key. You sign uploads with an **upload key**. If you lose it, Google can reset it (Play Console → App integrity), so it's not a disaster, but keep it safe.

**Easiest:** ask Claude to "create the Play upload key". You get a private file with the 3 values below, ready to paste. Save that file in your password manager or a private Google Drive folder, then delete it from Downloads.

**Or on a computer with Java:**
```bash
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 9125
```
```bash
base64 -w0 upload.jks > upload.jks.b64
```

Add these as **environment secrets**:

| Name | Value |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE_B64` | the base64 text of `upload.jks` |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_UPLOAD_KEY_ALIAS` | `upload` |

### 2b. Variables (for the privacy policy)
Add these as **environment variables** (same page, **Variables** tab):

| Name | Value |
|---|---|
| `SUPPORT_EMAIL` | the email shown on the privacy policy and in Play (people send deletion requests and complaints here) |
| `OPERATOR_NAME` | your name or business name, e.g. `Vijay Patel` or `XYZ Technologies` |
| `PRIVACY_POLICY_URL` | your production dashboard address + `/privacy`, e.g. `https://autoconfirm-dashboard.<subdomain>.workers.dev/privacy` |

## 3. Deploy, then check the privacy page
1. **Actions → Deploy → Run workflow**. This publishes the privacy page with your email.
2. Open `PRIVACY_POLICY_URL` in a browser, while logged out. You should see the policy, with your email under "Who we are".

## 4. Build the app for Play
1. **Actions → Android release → Run workflow** (optionally type what changed).
2. When it's green: repo → **Releases** → the draft **Android 0.2.0 (build 1xx)**. It's a draft, so only you can see it.
3. Download both files:
   - `autoconfirm-….aab` is what you upload to Play.
   - `autoconfirm-….apk` installs directly on a phone (signed with your upload key).

Every run gets a higher build number automatically, as Play requires.

---

## 5. Create the app in Play Console
**Home → Create app**:
- App name: `AutoConfirm: UPI shop alerts`
- Default language: **English (India) – en-IN**
- App or game: **App**. Free or paid: **Free**.
- Tick the declarations → **Create app**.

> The package name is `app.autoconfirm` and **can never change** after the first upload. If Play says it's taken, ask Claude to change `applicationId` before uploading anything.

## 6. App content (Policy → App content)
Answer each section like this.

### 6.1 Privacy policy
Paste your `PRIVACY_POLICY_URL`.

### 6.2 App access
Choose **All or some functionality is restricted**, then **Add instructions**:
- Name: `Demo mode (no account needed)`
- Username / password: leave empty (tick "No username or password is required" if offered)
- Instructions:
```text
AutoConfirm runs on a shop's counter phone and is paired with the shop's account by scanning a QR code from the shop's dashboard. To review without a shop account:
1. Open the app and tap "No shop yet? See how it works (demo)".
2. The demo shows the real setup checklist and example payments. Tap "Turn on" next to "Notification access" to see the prominent disclosure, then "Agree and continue" to open Android's notification access settings.
In demo mode the phone is not paired, so no notifications are read and nothing is sent.
Core function when paired: the app reads "money received" notifications from payment apps and bank credit SMS alerts, extracts only the amount, time, short payer name and payment reference, and sends them to the shop's own AutoConfirm server, which marks the matching order as paid.
```

### 6.3 Ads
**No, my app does not contain ads.**

### 6.4 Content rating
Start questionnaire → email → category **All Other App Types**. Answer **No** to everything (violence, sexuality, language, controlled substances, gambling, user interaction/sharing content, sharing location, digital purchases). Expected rating: Everyone / 3+.

### 6.5 Data safety
**Overview:**
- Does your app collect or share any of the required user data types? **Yes**
- Is all of the user data collected by your app encrypted in transit? **Yes**
- Do you provide a way for users to request that their data is deleted? **Yes** → URL: `PRIVACY_POLICY_URL` + `#delete`

**Data types:** tick only these. For each one: **Collected: yes. Shared: no. Processed ephemerally: no. Required** (users can't turn it off). **Purpose: App functionality** (also **Fraud prevention, security, and compliance** where shown).

| Category → type | What it is in AutoConfirm |
|---|---|
| Personal info → **Name** | Short payer name from a payment alert ("Ramesh P") |
| Financial info → **Other financial info** | Amount, time and payment reference (UTR) of money received |
| App info and performance → **Diagnostics** | Notification access on/off, battery optimisation, queue size, app version, phone model |
| Device or other IDs → **Device or other IDs** | The device ID the server assigns at pairing |

Leave everything else unticked: location, contacts, photos, audio, files, calendar, web history, health, and **Messages**. SMS text is processed only on the phone and never collected; only the amount/time/reference above leave the phone.

Why "Shared: no": data goes to the shop's own account on your AutoConfirm server. Cloudflare hosts it on your behalf, which Google counts as a service provider, not sharing.

### 6.6 Other declarations
| Section | Answer |
|---|---|
| Target audience and content | Age groups: **18 and over** only. Not designed for children. |
| News app | No |
| COVID-19 contact tracing/status | No / not applicable |
| Government app | No |
| Health apps | None |
| Financial features | **My app doesn't provide any financial features.** It doesn't make, receive, hold or move money; it only reads "money received" alerts for the shop owner. If asked for detail: "Business tool that confirms incoming UPI payments to the merchant's own account from their own notifications. No payments are initiated or processed." |
| Advertising ID | No (the app doesn't use it) |

---

## 7. Store listing (Grow users → Store presence → Main store listing)

**App name** (≤ 30): `AutoConfirm: UPI shop alerts`

**Short description** (≤ 80):
```text
Auto-confirms UPI payments to your shop's own UPI ID. No gateway, no % fee.
```

**Full description:**
```text
AutoConfirm tells your shop's website or counter the moment a customer's UPI payment reaches your own UPI ID, so orders are marked paid automatically.

How it works
• Every order gets a unique amount, like ₹930.07, so each payment can be told apart.
• The customer pays with any UPI app, straight into your own UPI ID. Money goes directly to your bank.
• This app runs on your shop's phone. When your payment app or bank shows "money received", AutoConfirm sends only the amount, time, payer's short name and reference to your AutoConfirm account, which marks the right order paid in seconds.

Why shops use it
• No payment gateway and no percentage fee.
• Works with the UPI ID you already have.
• Alerts if the shop phone goes offline, and a simple inbox for payments that need a look.
• Your website gets signed webhooks; staff see everything in the dashboard.

Privacy
• Reads notifications only from payment apps and bank "credited" SMS alerts, after you agree.
• Never sends the full notification text; never reads other apps.
• No SMS, contacts or location permissions. No ads.

Requires an AutoConfirm shop account (pair the phone by scanning a QR code from your dashboard). Tap "See how it works" in the app to try a demo.

AutoConfirm is a payment confirmation tool, not a payment gateway or bank. It is not affiliated with Google Pay, PhonePe, Paytm, NPCI or any bank.
```

**Graphics** (files in this repo, folder `apps/android/play/`; on a phone open the file on GitHub → **Download**):
- App icon: `icon-512.png`
- Feature graphic: `feature-graphic.png`
- Phone screenshots: at least 2, up to 8. Take them on the counter phone (Power + Volume down):
  1. the main screen showing **Online** and the checklist all ✓;
  2. the "Today" list with a paid payment;
  3. the notification-access disclosure;
  4. the demo screen.

**Category:** Business. **Contact details:** your `SUPPORT_EMAIL`; website = your dashboard address (optional).

---

## 8. Testing, then production

**a. Internal testing (minutes, up to 100 people)**
1. **Test and release → Testing → Internal testing → Create new release** → upload the `.aab` → paste release notes → **Save → Review → Start rollout**.
2. **Testers** tab → create an email list with your Gmail → copy the **join link**, open it on the counter phone, and install from Play.
3. First **uninstall the old sideloaded app**. Play's copy is signed differently and can't update it. Then pair again from the dashboard.
4. Check: pairing, notification access, a ₹1 test payment, and the phone-offline alert.

**b. Closed testing (personal accounts: 12 testers for 14 days)**
1. **Testing → Closed testing → Create track** (or use "Alpha") → upload the same `.aab` → roll out.
2. Add **at least 12 testers'** Gmail addresses. Each one must open the join link, accept, and install the app. They don't need a shop; the demo is enough.
3. Keep them opted in for **14 days in a row**. Play Console shows the count.

**c. Production**
1. **Dashboard → Apply for production** and answer the questions about your test (who tested, what you changed).
2. When approved: **Production → Create new release** → upload the `.aab` → roll out (start at 20% if you like).

**Demo video** (keep it ready, Google sometimes asks for one): use Android's screen recorder for about 30 s.
1. Open the app and show the demo screen.
2. Tap **Turn on** and show the disclosure.
3. Tap **Agree and continue** and show the notification-access setting.

## 9. If a reviewer asks about notification access or SMS
Paste:
```text
AutoConfirm is a business tool for shop owners. Its core and only function is to confirm UPI payments the shop receives into its own UPI ID. To do this it uses NotificationListenerService to read "money received" alerts from payment apps and bank "credited" SMS alerts shown by the messaging app (only from bank sender IDs on an allow-list). It does not request READ_SMS or any SMS/Call Log permission, and never reads the SMS inbox.
From a matching alert it extracts only the amount, time, a short payer name and the payment reference, and sends them over HTTPS to the shop's own AutoConfirm account. Notifications from all other apps, other SMS and the full text are never stored or sent. Before access is requested, the app shows a prominent disclosure with an explicit "Agree and continue" button. The user can pause sending or unpair at any time, which deletes all data on the phone.
```

In-app disclosure (exact text):
> AutoConfirm reads notifications on this phone to see when your shop receives money:
> • alerts from the payment apps you use (like Google Pay, PhonePe Business, Paytm for Business), and
> • bank "credited" SMS alerts shown by your messaging app, only from bank sender IDs.
>
> From these it takes only the amount, time, a short payer name ("Ramesh P") and the payment reference, and sends them to your shop's AutoConfirm server to mark orders as paid.
>
> Notifications from other apps, other SMS and the full notification text are never stored or sent. Nothing is read until this phone is paired with your shop. Your data is not sold or used for ads.

## 10. Updates later
1. Ask Claude to make the change and bump `versionName` in `apps/android/app/build.gradle.kts`.
2. Merge, then **Actions → Android release → Run workflow**.
3. Upload the new `.aab` to the same track (internal → closed → production).

Parser-rule fixes (a payment app changed its wording) **don't** need an app update: they go out with the normal Deploy.

## 11. Things to know
- **Notification access on Play installs:** the "Allow restricted settings" step from the sideloaded APK isn't needed; Android only blocks it for sideloaded apps.
- **Battery:** still ask shops to set battery to **Unrestricted** (USER-MANUAL D4). The app never requests a battery exemption itself; that permission is restricted on Play.
- **Changing what the app reads or sends** means updating the disclosure (`DISCLOSURE_TEXT` in `MainActivity.kt`), the privacy page (`apps/dashboard/src/routes/privacy`) and §6.5 together. `PolicyTest` checks the disclosure.
- This guide is practical advice, not legal advice. For a business with outside clients, have the privacy policy and terms reviewed (COMPLIANCE.md).
