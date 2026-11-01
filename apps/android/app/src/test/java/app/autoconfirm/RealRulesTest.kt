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
        assertEquals(listOf("google_pay", "phonepe", "paytm"), rules.apps.map { it.id })
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

    @Test fun bank_sms_and_email_are_not_read() {
        // Captured 2026-11-01: the payer's own debit SMS, and an email alert. Neither app is in the rules.
        assertEquals(
            ParseResult.NotPaymentApp,
            NotificationParser.parse(rules, "com.google.android.apps.messaging", "AX-IDFCFB-S", "Your A/c XX4697 debited by Rs. 1.00 on 01/11/26; VIJAYKUMAR PATEL credited. RRN 630570868401.", ""),
        )
        assertEquals(ParseResult.NotPaymentApp, NotificationParser.parse(rules, "com.google.android.gm", "Axis Bank Alerts", "INR 1.00 was credited to your A/c.", ""))
    }

    @Test fun honorifics_are_dropped_from_payer_names() {
        assertEquals("Vijaykumar P", Payer.short("Mr. Vijaykumar Patel"))
        assertEquals("Anita S", Payer.short("Smt Anita Shah"))
        assertEquals("Ravi", Payer.short("Dr Ravi"))
    }
}
