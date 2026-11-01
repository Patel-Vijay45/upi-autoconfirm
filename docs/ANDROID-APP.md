# AutoConfirm Android app (merchant's counter phone)

The app's only job is to **notice "money received" notifications from the merchant's payment app and report them, securely, within seconds, and keep doing it all day**.

## 1. Requirements
- Android 8.0+ (API 26+). Most counter phones in India are Android.
- **iPhone is not possible:** iOS doesn't let apps read other apps' notifications.
- The merchant's business payment app is installed and logged in on the same phone: PhonePe Business, Paytm for Business, Google Pay for Business, BharatPe, or a bank merchant app.
- Internet (mobile data or Wi-Fi).

## 2. Tech
| Concern | Choice |
|---|---|
| Language/UI | Kotlin + Jetpack Compose (simple 3-screen app) |
| Reading notifications | `NotificationListenerService` (user grants "Notification access" in Settings) |
| Local queue | Room (SQLite): each signal stored before sending, deleted after 2xx |
| Sending | OkHttp, HTTPS only, certificate pinning to our API domain (with a backup pin) |
| Background work | WorkManager (retry queue, 15-min periodic sync), plus an immediate send from the listener callback |
| Secure storage | `device_secret` encrypted with Android Keystore (AES-GCM key, non-exportable) |
| Config | Parser rules JSON pulled from `/device/v1/parser_rules` (ETag) on start and every 15 min |
| Phone-side warning | If notification access is turned off, the app shows "AutoConfirm can't see payments, tap to fix" (checked when the listener disconnects, every 15 min, at boot and while the app is open). Needs the Android 13+ notification permission (checklist item "Warnings on this phone allowed"). |
| Crash/health | Heartbeat to our API every 5 min while the listener is connected, every 30 s while the app is on screen (so "removed in the dashboard" shows at once), plus every 15 min from WorkManager (no third-party SDKs, to keep data private). A killed app stops heartbeating, so the server sees it as offline. |

## 3. Screens
1. **Pair:** scan the QR shown in the merchant dashboard (Locations → Add phone) with the phone's camera app. The QR holds an `autoconfirm://pair?api=…&code=pc_…` link with a one-time code valid for 10 min, and it opens the app. No camera permission or scanning library is needed. The link can also be pasted.
2. **Setup checklist** (each item is a big green tick or a red "Fix" button):
   - Notification access is ON.
   - Battery optimisation is OFF for AutoConfirm (open the system setting).
   - Autostart is allowed (Xiaomi, Oppo, Vivo, Realme: deep-link to the vendor setting where possible; see dontkillmyapp.com).
   - The payment app is installed, and its notifications are ON and **not silenced**.
   - Test payment: "Send ₹1 to your own UPI ID from another phone", then the app shows "Received ₹1.00 ✓ sent to server".
3. **Status:** "Online · last payment 2 min ago · 0 waiting to send", today's list (amount, time, matched order), and a "Pause" switch.

## 4. Parsing notifications

### 4.1 What the listener sees
For each notification: package name, title, text, big text, `postTime` and key. Example, illustrative only, since real wording must be collected on real phones:
```
package: com.phonepe.app.business   title: "Payment received"   text: "₹930.07 received from RAMESH PATEL"
```

### 4.2 Rules (downloaded JSON, so wording changes are fixed without an app update)
```json
{
  "version": "2026-11-06.1",
  "apps": [
    {
      "id": "phonepe_business",
      "packages": ["com.phonepe.app.business"],
      "incoming": [
        { "field": "text", "regex": "₹\\s?([0-9,]+(?:\\.[0-9]{1,2})?)\\s+received from\\s+(.+)", "amount": 1, "payer": 2 }
      ],
      "ignore": ["(?i)paid to", "(?i)cashback", "(?i)refund", "(?i)request"]
    }
  ]
}
```
- Package names and regexes **must be verified on real devices** before real use (ROADMAP Step 2). The example above is a template, not tested wording.
- Rules can also match **bank SMS** shown as notifications by the SMS app (e.g. "Rs 930.07 credited to a/c XX1234 by VPA ramesh@okaxis"). This needs no SMS permission; we only read the notification.
- **Order of checks:** if the package isn't in the rules, ignore it. If an `ignore` pattern matches, ignore it. Otherwise try the `incoming` patterns. If one matches, it's a signal. If nothing matches but the text contains ₹ or Rs, record a parse failure.
  - App v0.1 only counts parse failures and shows the count on the status screen. Uploading redacted samples (opt-in) needs the `/device/v1/parse_failures` endpoint, which isn't built yet.
- Pattern fields: `field` is `title`, `text`, `big_text` or `any` (all three joined). `amount`, `payer` and `reference` are regex group numbers. A pattern that fails to compile is skipped, so it can't break the others.
- The amount is parsed as an exact decimal to paise: strip commas and **never use floating point**. "930.7" means 93070 paise.

### 4.3 What leaves the phone
`{ app, amount_paise, payer_short ("Ramesh P"), reference (if any), posted_at, notification_key_hash, rules_version }`
- The full notification text is **not** sent, except for **redacted** parse failures, and only if the merchant opted in.
- **No other app's notifications** are read or stored. The listener returns immediately for packages not in the rules.

## 5. Reliability (the hard part)
| Problem | Mitigation |
|---|---|
| The OS kills the app (Chinese OEM battery savers) | Setup checklist; detect `isIgnoringBatteryOptimizations`; heartbeat-missing alert to the merchant within 10 min |
| Notification listener disconnects silently | `onListenerDisconnected` → `requestRebind`; the heartbeat reports `listener_connected`; the server alerts if false |
| No internet | Room queue; retry with backoff; send on network-available callback; signals keep their original `posted_at`, which the server corrects for clock drift and uses so late signals can't pay newer orders |
| Payment app's notifications turned off or silenced | The checklist checks the notification channel importance where possible; a test payment confirms it end-to-end |
| Duplicate notifications (app updates the same notification) | Device-side dedupe by notification key + amount within 2 min; the server dedupes again (MATCHING §3) |
| Phone restarted | `BOOT_COMPLETED` receiver re-schedules work; the listener is rebound by the system |
| App update changes behaviour | Staged rollout; rules versioned; parse-failure rate alert per app and version |
| Two phones per location (backup) | Both send; the server dedupes. Recommended for busy counters. |

## 6. Security on the device
- `device_secret` never leaves the Keystore-protected storage, and it's not shown in the UI.
- Requests are signed: HMAC over method, path, timestamp, nonce and body hash (see API.md §8).
- **Certificate pinning** stops a hostile Wi-Fi network from intercepting traffic.
- **Remote revoke:** the merchant clicks "Remove phone" in the dashboard, and the server rejects that device immediately.
- **No accessibility service** and no SMS permission. This keeps Play Store review simpler and limits risk.
- **Local data:** the queue holds only parsed fields and is cleared after a successful send. Today's list in the UI is kept for 24 h.

## 7. Installing the current build (sideloaded APK)
Until the app is on the Play Store, Android shows two warnings (step by step in USER-MANUAL D2/D4):
- **Play Protect** may block the install: "More details → Install anyway", or pause Play Protect while installing.
- **Notification access** is blocked as a "restricted setting": Settings → Apps → AutoConfirm → ⋮ → **Allow restricted settings**, then turn on access for AutoConfirm.
- Battery: "App battery usage" → tap **Allow background usage** → **Unrestricted**.

Real-phone status (2026-11-01): Google Pay "<payer> paid you ₹X" alerts and IDFC FIRST credit SMS are verified and in `rules/parser-rules.json`; debit SMS are ignored. PhonePe/Paytm alerts and other banks' credit SMS still need real samples.

## 8. Distribution
- **Google Play:** apps using `NotificationListenerService` need a clear in-app disclosure and a privacy policy, and a store listing that explains the core use (see COMPLIANCE.md). Expect review questions.
- **Fallback:** a signed APK from our website, with a pinned update check inside the app.
- The minimum app version is enforced by the server: older apps are told to update before they can send.
