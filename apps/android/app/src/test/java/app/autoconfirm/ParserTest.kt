package app.autoconfirm

import app.autoconfirm.parse.Money
import app.autoconfirm.parse.NotificationParser
import app.autoconfirm.parse.ParseResult
import app.autoconfirm.parse.ParserRules
import app.autoconfirm.parse.Payer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ParserTest {
    private val rules = ParserRules.parse(File("../../../tools/rules/example.json").readText())
    private val pp = "com.phonepe.app.business"

    @Test fun money_is_exact_paise() {
        assertEquals(93007L, Money.toPaise("930.07"))
        assertEquals(93070L, Money.toPaise("930.7"))
        assertEquals(93000L, Money.toPaise("930"))
        assertEquals(125050L, Money.toPaise("₹ 1,250.50"))
        assertEquals(9900L, Money.toPaise("Rs. 99"))
        assertEquals(29L, Money.toPaise("0.29"))
        for (bad in listOf("", "abc", "1.234", "-5", "1e3", "12.", ".5")) assertNull(bad, Money.toPaise(bad))
        assertEquals("930.07", Money.format(93007))
        assertEquals("0.05", Money.format(5))
    }

    @Test fun payer_is_shortened() {
        assertEquals("Ramesh P", Payer.short("RAMESH PATEL"))
        assertEquals("Sita", Payer.short("  sita "))
        assertEquals("Ramesh K", Payer.short("Ramesh Kumar Patel"))
        assertNull(Payer.short("  "))
    }

    @Test fun rules_load() {
        assertEquals("2026-11-01.1", rules.version)
        assertEquals(2, rules.apps.size)
    }

    @Test fun incoming_payment_is_parsed() {
        val r = NotificationParser.parse(rules, pp, "Payment received", "₹930.07 received from RAMESH PATEL", "")
        assertEquals(ParseResult.Payment("phonepe_business", 93007, "Ramesh P", null), r)
    }

    @Test fun bank_sms_shown_as_notification() {
        val r = NotificationParser.parse(
            rules, "com.google.android.apps.messaging", "AX-HDFCBK",
            "Rs 1,250.50 credited to a/c XX1234 by VPA ramesh@okaxis on 31-10-26. Ref No 630412345678", "",
        )
        assertEquals(ParseResult.Payment("bank_sms", 125050, null, "630412345678"), r)
    }

    @Test fun outgoing_refund_and_promos_are_ignored() {
        for (text in listOf("₹500 paid to Big Bazaar", "You got ₹10 cashback", "Refund of ₹930.07 processed", "Payment request of ₹200", "Payment of ₹930 failed")) {
            assertTrue(text, NotificationParser.parse(rules, pp, "", text, "") is ParseResult.Ignored)
        }
    }

    @Test fun other_apps_are_never_parsed() {
        assertEquals(ParseResult.NotPaymentApp, NotificationParser.parse(rules, "com.whatsapp", "Ramesh", "₹930.07 received from RAMESH", ""))
    }

    @Test fun money_text_that_no_rule_reads_is_a_parse_failure() {
        assertEquals(ParseResult.Failed("phonepe_business"), NotificationParser.parse(rules, pp, "", "You have a new credit of ₹930.07", ""))
        assertTrue(NotificationParser.parse(rules, pp, "Offers", "Check out new offers", "") is ParseResult.Ignored)
    }

    @Test fun broken_rules_are_skipped_not_fatal() {
        val r = ParserRules.parse(
            """{"version":"x","apps":[{"id":"a_app","packages":["p"],"incoming":[{"field":"text","regex":"([","amount":1},{"field":"text","regex":"got ₹([0-9.]+)","amount":1}],"ignore":["("]},{"id":"BAD ID","packages":["q"]}]}""",
        )
        assertEquals(1, r.apps.size)
        assertEquals(ParseResult.Payment("a_app", 1000, null, null), NotificationParser.parse(r, "p", "", "got ₹10", ""))
    }

    @Test fun zero_amount_is_not_a_payment() {
        assertTrue(NotificationParser.parse(rules, pp, "", "₹0 received from X Y", "") !is ParseResult.Payment)
    }
}
