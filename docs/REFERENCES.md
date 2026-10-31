# References and resources

Official sources first. Links were correct when written (Oct 2026). Re-check prices and policies before launch, because they change.

## UPI and NPCI
- NPCI UPI product overview: https://www.npci.org.in/what-we-do/upi/product-overview
- NPCI UPI circulars (rules for amounts, collect requests, deep links): https://www.npci.org.in/what-we-do/upi/circular
- UPI deep link / URI format (`upi://pay?pa=…&pn=…&am=…&tr=…&tn=…&cu=INR`), from the NPCI "UPI Linking Specification" (search "UPI Linking Specs NPCI pdf"); also summarised in the Google Pay docs below.
- Google Pay for Business (merchant app): https://pay.google.com/intl/en_in/about/business/

## Google Pay (India) developer docs
- Google Pay India overview: https://developers.google.com/pay/india
- UPI intent / deep links for web and Android: https://developers.google.com/pay/india/api/web/upi-intent and https://developers.google.com/pay/india/api/android/in-app-payments
- Web Payments (PaymentRequest) with Google Pay India (needs a verified merchant + PSP; Android Chrome only): https://developers.google.com/pay/india/api/web/googlepay

## Payment gateways (for comparison and pricing)
- Razorpay pricing: https://razorpay.com/pricing/
- Cashfree pricing: https://www.cashfree.com/payment-gateway-charges/ (check the prohibited-business list: fireworks are listed)
- Paytm Payment Gateway pricing: https://business.paytm.com/payment-gateway
- PhonePe Payment Gateway: https://www.phonepe.com/business-solutions/payment-gateway/

## Regulation and law (India)
- RBI Payment Aggregator / Payment Gateway guidelines (Master Direction on PA-PG): https://www.rbi.org.in (search "Payment Aggregators guidelines")
- Digital Personal Data Protection Act 2023 and DPDP Rules: https://www.meity.gov.in/data-protection-framework
- IT Act 2000 / CERT-In directions (incident reporting within 6 hours): https://www.cert-in.org.in
- GST on software services (SAC 998314 / 998315): https://cbic-gst.gov.in

## Android
- NotificationListenerService: https://developer.android.com/reference/android/service/notification/NotificationListenerService
- Foreground services and their types: https://developer.android.com/develop/background-work/services/foreground-services
- WorkManager (reliable background retries): https://developer.android.com/develop/background-work/background-tasks/persistent
- Android Keystore (device secret storage): https://developer.android.com/privacy-and-security/keystore
- Play Integrity API (optional device attestation): https://developer.android.com/google/play/integrity
- Google Play policies (permissions, notification access, financial apps): https://support.google.com/googleplay/android-developer/answer/16810878 and the Developer Policy Center: https://play.google/developer-content-policy/
- Don't kill my app (battery settings by phone brand): https://dontkillmyapp.com

## Cloudflare (recommended stack)
- Workers: https://developers.cloudflare.com/workers/
- Durable Objects (one per merchant location; WebSocket hibernation): https://developers.cloudflare.com/durable-objects/
- D1: https://developers.cloudflare.com/d1/ (Time Travel backups: https://developers.cloudflare.com/d1/reference/time-travel/)
- Queues (webhook delivery with retries): https://developers.cloudflare.com/queues/
- KV (parser rules): https://developers.cloudflare.com/kv/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Rate limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Turnstile (bot protection on public endpoints): https://developers.cloudflare.com/turnstile/
- Pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Hono (small web framework for Workers): https://hono.dev

## Design patterns we copied
- Stripe API design (idempotency keys, webhook signatures `t=…,v1=…`, test/live keys): https://docs.stripe.com/api/idempotent_requests and https://docs.stripe.com/webhooks#verify-events
- Standard Webhooks spec: https://www.standardwebhooks.com
- OWASP ASVS (security checklist): https://owasp.org/www-project-application-security-verification-standard/
- OWASP API Security Top 10: https://owasp.org/API-Security/

## Libraries and tools
- QR as SVG on the server: `qrcode` (npm) or `uqr` (tiny, zero-dependency)
- Testing: Vitest, fast-check (property tests), Playwright, k6
- Android: Kotlin, OkHttp, Room (offline queue), WorkManager, kotlinx.serialization
- OpenAPI docs viewer: Scalar or Redoc (point it at `api/openapi.yaml`)
