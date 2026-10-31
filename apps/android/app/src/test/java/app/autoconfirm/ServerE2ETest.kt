package app.autoconfirm

import app.autoconfirm.data.Credentials
import app.autoconfirm.data.OutboxSignal
import app.autoconfirm.net.ApiClient
import app.autoconfirm.net.PairingLink
import app.autoconfirm.net.Signer
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Runs the app's network code against a real AutoConfirm API (e.g. `wrangler dev`).
 * Skipped unless AUTOCONFIRM_E2E_LINK (a test-mode pairing link) and AUTOCONFIRM_E2E_AMOUNT (an open
 * intent's unique_amount in paise) are set. See apps/android/README.md.
 */
class ServerE2ETest {
    @Test fun pair_heartbeat_and_confirm_a_payment() {
        val raw = System.getenv("AUTOCONFIRM_E2E_LINK")
        val amount = System.getenv("AUTOCONFIRM_E2E_AMOUNT")?.toLongOrNull()
        assumeTrue("set AUTOCONFIRM_E2E_LINK and AUTOCONFIRM_E2E_AMOUNT to run", raw != null && amount != null)

        val link = PairingLink.parse(raw!!, allowInsecureLocal = true)
        assertNotNull("bad pairing link", link)
        val api = ApiClient(OkHttpClient())
        val enrolled = api.enroll(link!!, "E2E test", "jvm", "test", "0.1.0")
        assertEquals(false, enrolled.livemode)
        val creds = Credentials(link.apiBase, enrolled.deviceId, enrolled.secret)

        api.heartbeat(creds, listenerConnected = true, appVersion = "0.1.0", queueSize = 0, batteryOptimized = false)

        val now = System.currentTimeMillis()
        val wrong = OutboxSignal(1, 1, "phonepe_business", amount!! - amount % 100, "Ramesh P", null, now, Signer.keyHash("e2e-1-$now"), "e2e")
        val right = OutboxSignal(2, 2, "phonepe_business", amount, "Ramesh P", null, now, Signer.keyHash("e2e-2-$now"), "e2e")
        val results = api.sendSignals(creds, listOf(wrong, right))
        assertEquals("unmatched", results[0].status) // round amount: goes to the inbox
        assertEquals("matched", results[1].status) // exact unique amount: order paid

        // Sending the same upload again is recognised as a repeat.
        assertEquals(true, api.sendSignals(creds, listOf(right))[0].repeat)
    }
}
