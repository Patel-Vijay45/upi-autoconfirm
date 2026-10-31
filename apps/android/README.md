# AutoConfirm Android app

The phone app for the merchant's counter. It reads "money received" notifications from payment apps, parses them on the phone using rules from the server, and sends only the parsed fields, signed, to the AutoConfirm API. Design: [docs/ANDROID-APP.md](../../docs/ANDROID-APP.md).

## Build
Needs JDK 17+ and the Android SDK (platform 36). Point `ANDROID_HOME` at the SDK, or put `sdk.dir=…` in `local.properties`.

```bash
./gradlew testDebugUnitTest assembleDebug
```

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. Install it with `adb install` or by copying it to the phone.

Release build (minified): `./gradlew assembleRelease`, then sign the APK with your own key. Keystores are git-ignored.

## Certificate pinning (release)
Pass your API host and two SPKI pins (primary + backup):
```bash
./gradlew assembleRelease -Pautoconfirm.pinHost=api.example.com -Pautoconfirm.pins=sha256/AAAA…,sha256/BBBB…
```
Without them, the app uses normal HTTPS checks only.

## Pairing
1. Create a pairing code: `POST /v1/locations/:id/pairing_codes` (or the dashboard, later).
2. Show its `pairing_link` (`autoconfirm://pair?api=…&code=pc_…`) as a QR code.
3. Scan it with the phone's camera app, which opens AutoConfirm. You can also paste the link into the app.

Release builds only accept `https://` API addresses. Debug builds also accept `http://10.0.2.2`, `localhost` and `127.0.0.1` for local testing with `wrangler dev`.

## Parser rules
The app has no built-in rules. It downloads them from `GET /device/v1/parser_rules`, which serves the KV key `active`. A template is in [tools/rules/example.json](../../tools/rules/example.json). The package names and wording in it **must be checked on real phones** first. To publish rules locally:
```bash
cd apps/api && npx wrangler kv key put --binding RULES --local active --path ../../tools/rules/example.json
```

## Tests
- `ParserTest`: money parsing, payer shortening, rules, ignore patterns, parse failures.
- `NetTest`: request signing matches the server byte for byte, request format, rule caching, pairing links.
- `ServerE2ETest`: the app's network code against a running API. It is skipped unless you set `AUTOCONFIRM_E2E_LINK` (a test-mode pairing link) and `AUTOCONFIRM_E2E_AMOUNT` (an open intent's `unique_amount`).

## What the app never does
- It never requests SMS, Accessibility, camera, contacts or location permissions.
- It never stores or sends notification text. Other apps' notifications are dropped on the first line of the listener.
- It never shows the device secret. The secret is encrypted with a non-exportable Android Keystore key.
