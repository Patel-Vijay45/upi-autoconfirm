package app.autoconfirm

import app.autoconfirm.parse.NotificationParser
import app.autoconfirm.parse.ParseResult
import app.autoconfirm.parse.ParserRules
import app.autoconfirm.parse.Payer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The live rules (rules/parser-rules.json) against notifications captured on real phones. */
class RealRulesTest {
    private val rules = ParserRules.parse(File("../../../rules/parser-rules.json").readText())
    private val gpay = "com.google.android.apps.nbu.paisa.user"

    @Test fun every_rule_compiles() {
        // A pattern that fails to compile is dropped silently; make sure none were.
        assertEquals(listOf("google_pay", "phonepe", "paytm", "bank_sms"), rules.apps.map { it.id })
        rules.apps.forEach { assertTrue(it.id, it.incoming.isNotEmpty()) }
    }

    @Test fun google_pay_paid_you_2026_11_01() {
        // Captured 2026-11-01: title "Mr. Vijaykumar Patel paid you ₹1.00", text = payer's note "return".
        val r = NotificationParser.parse(rules, gpay, "Mr. Vijaykumar Patel paid you ₹1.00", "return", "")
        assertEquals(ParseResult.Payment("google_pay", 100, "Vijaykumar P", null), r)
    }

    @Test fun google_pay_bigger_amounts_and_business_app() {
        assertEquals(
            ParseResult.Payment("google_pay", 123456, "Sita K", null),
            NotificationParser.parse(rules, "com.google.android.apps.nbu.paisa.merchant", "SITA KUMARI paid you ₹1,234.56", "", ""),
        )
        assertEquals(
            ParseResult.Payment("google_pay", 93007, "Ramesh", null),
            NotificationParser.parse(rules, gpay, "Ramesh paid you ₹930.07", "", ""),
        )
    }

    @Test fun google_pay_outgoing_and_promos_are_not_payments() {
        for (title in listOf("You paid ₹50.00 to Big Bazaar", "Payment failed", "You won ₹10 cashback", "Asha requested ₹200")) {
            assertTrue(title, NotificationParser.parse(rules, gpay, title, "", "") !is ParseResult.Payment)
        }
    }

    @Test fun the_payers_note_cannot_change_the_amount() {
        // The note is in the text, not the title, so "paid you ₹9999" in a note is ignored.
        val r = NotificationParser.parse(rules, gpay, "Asha paid you ₹1.00", "paid you ₹9999.00", "")
        assertEquals(ParseResult.Payment("google_pay", 100, "Asha", null), r)
    }

    private val sms = "com.google.android.apps.messaging"

    @Test fun idfc_credit_sms_2026_11_01() {
        // Captured 2026-11-01 (two payments, two sender prefixes).
        assertEquals(
            ParseResult.Payment("bank_sms", 149, null, null),
            NotificationParser.parse(rules, sms, "JD-IDFCFB-S", "Your A/C XXXXX534697 is credited with INR 1.49 on 01/11/26 18:47. Your new balance is INR 40,423.92. Team IDFC FIRST Bank", ""),
        )
        assertEquals(
            ParseResult.Payment("bank_sms", 131, null, null),
            NotificationParser.parse(rules, sms, "JK-IDFCFB-S", "Your A/C XXXXX534697 is credited with INR 1.31 on 01/11/26 18:42. Your new balance is INR 40,422.43. Team IDFC FIRST Bank", ""),
        )
    }

    @Test fun debit_sms_are_ignored_2026_11_01() {
        // Captured 2026-11-01: the payer's side of the payment (IDFC and Axis).
        val idfcDebit = "Your A/c XX4697 debited by Rs. 1.00 on 01/11/26; VIJAYKUMAR PATEL credited. RRN 630570868401. Available balance Rs. 40,021.12. Team IDFC FIRST Bank"
        assertTrue(NotificationParser.parse(rules, sms, "AX-IDFCFB-S", idfcDebit, "") is ParseResult.Ignored)
        val axisDebit = "INR 1.31 debited\nA/c no. XX7641\n01-11-26, 18:42:56\nUPI/P2A/630563504245/Vijaykumar Patel\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank"
        assertTrue(NotificationParser.parse(rules, sms, "AD-AXISBK-S", axisDebit, "") is ParseResult.Ignored)
    }

    @Test fun axis_style_credit_sms_with_utr_and_payer() {
        // Derived from the real Axis debit format above (credit sample still to be captured).
        val text = "INR 930.07 credited\nA/c no. XX7641\n01-11-26, 18:42:56\nUPI/P2A/630563504245/Vijaykumar Patel\nAxis Bank"
        assertEquals(ParseResult.Payment("bank_sms", 93007, "Vijaykumar P", "630563504245"), NotificationParser.parse(rules, sms, "AD-AXISBK-S", text, ""))
    }

    @Test fun an_sms_from_an_ordinary_number_cannot_fake_a_payment() {
        val fake = "Your A/C XXXXX534697 is credited with INR 930.07 on 01/11/26 18:47. Team IDFC FIRST Bank"
        for (sender in listOf("+919876543210", "9876543210", "IDFC Bank", "JD-IDFCFX-S")) {
            assertTrue(sender, NotificationParser.parse(rules, sms, sender, fake, "") !is ParseResult.Payment)
        }
    }

    @Test fun otp_and_collect_requests_are_ignored() {
        assertTrue(NotificationParser.parse(rules, sms, "VM-HDFCBK", "123456 is your OTP. Rs 500.00 will be debited from A/c XX12", "") is ParseResult.Ignored)
        assertTrue(NotificationParser.parse(rules, sms, "VM-SBIUPI", "Asha has requested Rs.200.00 from you. On approval A/c XX12 will be debited", "") is ParseResult.Ignored)
    }

    @Test fun email_is_not_read() {
        assertEquals(ParseResult.NotPaymentApp, NotificationParser.parse(rules, "com.google.android.gm", "Axis Bank Alerts", "INR 1.00 was credited to your A/c.", ""))
    }

    @Test fun honorifics_are_dropped_from_payer_names() {
        assertEquals("Vijaykumar P", Payer.short("Mr. Vijaykumar Patel"))
        assertEquals("Anita S", Payer.short("Smt Anita Shah"))
        assertEquals("Ravi", Payer.short("Dr Ravi"))
    }
}
