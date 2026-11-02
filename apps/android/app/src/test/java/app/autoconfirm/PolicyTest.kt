package app.autoconfirm

import app.autoconfirm.ui.DISCLOSURE_TEXT
import org.junit.Assert.assertTrue
import org.junit.Test

/** Google Play's prominent-disclosure rules: say what is read, what is sent, and what is never collected. */
class PolicyTest {
    @Test fun disclosure_covers_everything_the_app_reads_and_sends() {
        for (must in listOf("payment apps", "SMS", "amount", "payer name", "payment reference", "never stored or sent", "paired")) {
            assertTrue("disclosure must mention \"$must\"", DISCLOSURE_TEXT.contains(must))
        }
    }
}
