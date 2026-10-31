# Compliance and legal (read before selling this)

> **Not legal advice.** These are the questions to take to a fintech lawyer and a CA before launch. Rules in India change often. Check the latest RBI and NPCI circulars.

## 1. RBI: are we a Payment Aggregator (PA)?
- RBI regulates **payment aggregators and payment gateways** (Guidelines on Regulation of Payment Aggregators and Payment Gateways, March 2020, plus later updates and master directions).
- Payment aggregators **receive customer funds** into an escrow/nodal account and later settle them to merchants. They need RBI authorisation and minimum net-worth requirements.
- **Our design never receives, holds or routes funds.** Customers pay directly into the merchant's own UPI ID, and we only process a **copy of the merchant's own payment notification** to update order status. That is closer to **reconciliation / order-management software** than to a PA or PG.

**Ask the lawyer to confirm, in writing:**
1. With no funds flow, no PA authorisation is needed.
2. Whether calling it "payment gateway" in marketing creates risk. Recommendation: use **"UPI payment confirmation / auto-reconciliation"** and avoid "gateway".
3. Whether generating `upi://` links with merchant VPAs, including app-specific links, raises any NPCI issue. These are standard UPI deep links, but check the NPCI UPI linking specs.
4. Any obligations if we later add bank APIs, which may need agreements with the bank or PA.

## 2. NPCI / UPI rules to respect
- Use **only the merchant's own VPA**, never a pooled or collection VPA of ours.
- **Business UPI IDs:** advise merchants to use merchant VPAs. Personal VPAs receiving many commercial payments can be flagged by banks, and some apps limit intent payments to personal VPAs.
- Per-transaction and daily **UPI limits** apply (set by NPCI, banks and apps). Show a clear message for large orders.
- Don't use UPI "collect requests" from our side.

## 3. Data protection: DPDP Act 2023 (and its Rules)
We process personal data: customer names, phones, payer names and amounts.
- **Role:** for merchants' customers, the merchant is usually the *Data Fiduciary* and we are the *Data Processor*. Sign a **Data Processing Agreement** in the merchant terms.
- **For our own users** (merchant staff) we're the fiduciary.
- **Must-haves:**
  - Privacy policy and processing purpose; collect only what's needed (see SECURITY §4).
  - Retention limits and deletion on request.
  - Reasonable security safeguards.
  - **Breach notification** to the Data Protection Board and affected people as the Rules require.
  - A grievance officer and contact.
  - Data stays with providers we've disclosed. Cloudflare's network is global; check whether any data-localisation expectations apply to payment-related data, ask the lawyer, and consider Cloudflare's regional data features.
- **RBI data localisation** (2018) applies to payment system operators' payment data. We aren't a payment system operator, but get the lawyer's view.

## 4. Google Play policies (Android app)
- `NotificationListenerService` access needs a **prominent in-app disclosure** explaining what's read and why, before asking for it. You also need a privacy policy link and an accurate **Data safety** form.
- **Don't request SMS or Call Log permissions.** These are restricted on Play and usually rejected for this use case. Bank SMS can still be read as notifications.
- **Don't use AccessibilityService** for this. It's heavily restricted.
- Expect manual review. Keep a short demo video ready that shows the core function.
- If rejected, distribute the APK directly from our site. Merchants install it once; still keep the disclosure and privacy policy.

## 5. Payment apps' terms
- Read the terms of PhonePe Business, Paytm for Business, Google Pay for Business and BharatPe.
- We don't call their servers or scrape their apps. We only read notifications **the merchant receives on their own phone**, with the merchant's consent.
- Avoid using their logos or brand names in ways that suggest a partnership.
- On the checkout, "Pay with Google Pay / PhonePe / Paytm" labels are descriptive. Follow each brand's usage guidelines for buttons and logos, or use text-only buttons.

## 6. Merchant contract essentials (Terms of Service)
- The service confirms payments based on the merchant's device notifications. The **merchant is responsible** for keeping the device online and for final verification of high-value orders.
- **No custody of funds;** no responsibility for chargebacks, refunds or disputes between merchant and customer.
- **Acceptable use:**
  - Lawful goods and services only.
  - No use for third-party trust scenarios (escrow, marketplaces).
  - The merchant must follow their own licence conditions (for example, local trade licences).
- **Data Processing Agreement** (DPDP), SLA and support hours, pricing and cancellation.

## 7. Tax and business
- A company (Pvt Ltd or LLP) is recommended for contracts and liability.
- GST registration for subscription revenue (SaaS is 18% GST); issue GST invoices.
- If selling to merchants across India: invoice by state (IGST/CGST/SGST rules); a CA to set up.

## 8. Before public launch: compliance checklist
- [ ] Written legal opinion on PA/PG status and marketing language
- [ ] Privacy policy, terms of service, DPA, grievance officer published
- [ ] Data retention jobs running; deletion/export tools tested
- [ ] Play Store disclosure + Data safety form, or a signed direct-APK channel
- [ ] Security review / pen test done (SECURITY.md checklist complete)
- [ ] Incident and breach-notification process written and owners assigned
