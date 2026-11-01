package app.autoconfirm

import app.autoconfirm.data.Credentials
import app.autoconfirm.data.OutboxSignal
import app.autoconfirm.net.ApiClient
import app.autoconfirm.net.ApiException
import app.autoconfirm.net.PairingLink
import app.autoconfirm.net.Signer
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class NetTest {
    private lateinit var server: MockWebServer
    private lateinit var creds: Credentials
    private val now = 1_793_452_051_000L
    private val api = ApiClient(OkHttpClient(), clock = { now })

    @Before fun start() {
        server = MockWebServer().apply { start() }
        creds = Credentials(server.url("/").toString().trimEnd('/'), "dev_abc", "devsecret")
    }

    @After fun stop() = server.shutdown()

    @Test fun signature_matches_the_server_implementation() {
        // Vector produced by packages/core signDeviceRequest() with the same inputs.
        assertEquals(
            "47dc536217dde5b360dff3ec09e0665c11da8488915fda4cdc5681625a0caa00",
            Signer.sign("devsecret", "POST", "/device/v1/signals", "1793452051", "n_0123456789abcdef", """{"signals":[]}"""),
        )
        assertTrue(Signer.nonce().matches(Regex("^n_[0-9a-f]{32}$")))
        assertTrue(Signer.keyHash("0|com.phonepe|1|null|10001").matches(Regex("^[0-9a-f]{32}$")))
    }

    @Test fun signals_are_sent_signed_with_parsed_fields_only() {
        server.enqueue(MockResponse().setBody("""{"results":[{"ok":true,"signal_id":"sig_1","status":"matched","repeat":false,"code":null}]}"""))
        val item = OutboxSignal(1, 1, "phonepe_business", 93007, "Ramesh P", null, now - 1000, "ab".repeat(16), "v1")
        val results = api.sendSignals(creds, listOf(item))
        assertEquals("matched", results[0].status)
        assertEquals("sig_1", results[0].signalId)

        val req = server.takeRequest()
        val body = req.body.readUtf8()
        assertEquals("/device/v1/signals", req.path)
        assertEquals("dev_abc", req.getHeader("x-device-id"))
        assertEquals("1793452051", req.getHeader("x-timestamp"))
        val expected = Signer.sign("devsecret", "POST", "/device/v1/signals", req.getHeader("x-timestamp")!!, req.getHeader("x-nonce")!!, body)
        assertEquals(expected, req.getHeader("x-signature"))
        val sent = JSONObject(body).getJSONArray("signals").getJSONObject(0)
        assertEquals(setOf("app", "amount_paise", "payer_short", "posted_at", "notification_key_hash", "rules_version"), sent.keys().asSequence().toSet())
        assertEquals(93007, sent.getInt("amount_paise"))
    }

    @Test fun unpair_is_a_signed_post() {
        server.enqueue(MockResponse().setBody("{\"ok\":true}"))
        api.unpair(creds)
        val req = server.takeRequest()
        assertEquals("/device/v1/unpair", req.path)
        assertEquals("POST", req.method)
        assertEquals(Signer.sign("devsecret", "POST", "/device/v1/unpair", req.getHeader("x-timestamp")!!, req.getHeader("x-nonce")!!, "{}"), req.getHeader("x-signature"))
    }

    @Test fun heartbeat_reports_phone_time() {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        api.heartbeat(creds, listenerConnected = true, appVersion = "0.1.0", queueSize = 2, batteryOptimized = false)
        val body = JSONObject(server.takeRequest().body.readUtf8())
        assertEquals(now, body.getLong("device_time"))
        assertEquals(2, body.getInt("queue_size"))
    }

    @Test fun rules_use_version_caching() {
        server.enqueue(MockResponse().setResponseCode(304))
        assertNull(api.parserRules(creds, "2026-11-01.1"))
        assertEquals("/device/v1/parser_rules?version=2026-11-01.1", server.takeRequest().path)
        server.enqueue(MockResponse().setBody("""{"version":"2","apps":[]}"""))
        assertEquals("""{"version":"2","apps":[]}""", api.parserRules(creds, null))
    }

    @Test fun revoked_phone_is_an_auth_failure_but_replay_is_not() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"unauthorized"}}"""))
        val e = runCatching { api.heartbeat(creds, true, "x", 0, false) }.exceptionOrNull() as ApiException
        assertTrue(e.isAuthFailure)
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"replayed_nonce"}}"""))
        val r = runCatching { api.heartbeat(creds, true, "x", 0, false) }.exceptionOrNull() as ApiException
        assertFalse(r.isAuthFailure)
    }

    @Test fun pairing_links_must_be_https() {
        assertEquals(
            PairingLink("https://api.example.com", "pc_0123456789abcdefABCD"),
            PairingLink.parse("autoconfirm://pair?api=https%3A%2F%2Fapi.example.com%2F&code=pc_0123456789abcdefABCD"),
        )
        assertNull(PairingLink.parse("autoconfirm://pair?api=http%3A%2F%2Fapi.example.com&code=pc_0123456789abcdefABCD"))
        assertNull(PairingLink.parse("autoconfirm://pair?api=https%3A%2F%2Fapi.example.com&code=bad"))
        assertNull(PairingLink.parse("https://evil.example/pair?code=pc_0123456789abcdefABCD"))
        // Local HTTP only in debug builds (emulator talking to wrangler dev).
        assertNull(PairingLink.parse("autoconfirm://pair?api=http%3A%2F%2F10.0.2.2%3A8787&code=pc_0123456789abcdefABCD"))
        assertEquals(
            "http://10.0.2.2:8787",
            PairingLink.parse("autoconfirm://pair?api=http%3A%2F%2F10.0.2.2%3A8787&code=pc_0123456789abcdefABCD", allowInsecureLocal = true)?.apiBase,
        )
    }
}
