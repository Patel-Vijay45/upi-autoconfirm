package app.autoconfirm.net

import app.autoconfirm.data.Credentials
import app.autoconfirm.data.OutboxSignal
import okhttp3.CertificatePinner
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, val code: String?, message: String) : Exception(message) {
    /** The server no longer accepts this phone (removed in the dashboard, or credentials invalid). */
    val isAuthFailure: Boolean get() = status == 401 && code != "replayed_nonce"
}

data class EnrollResult(val deviceId: String, val secret: String, val locationId: String, val livemode: Boolean)
data class SignalResult(val ok: Boolean, val signalId: String?, val status: String?, val repeat: Boolean, val code: String?)

/** What the dashboard QR holds: autoconfirm://pair?api=<https base url>&code=pc_... */
data class PairingLink(val apiBase: String, val code: String) {
    companion object {
        private val CODE = Regex("^pc_[0-9A-Za-z]{16,64}$")
        private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2")

        fun parse(raw: String, allowInsecureLocal: Boolean = false): PairingLink? {
            val uri = try {
                URI(raw.trim())
            } catch (e: Exception) {
                return null
            }
            if (uri.scheme != "autoconfirm" || uri.host != "pair") return null
            val q = (uri.rawQuery ?: "").split("&").mapNotNull {
                val kv = it.split("=", limit = 2)
                if (kv.size == 2) URLDecoder.decode(kv[0], "UTF-8") to URLDecoder.decode(kv[1], "UTF-8") else null
            }.toMap()
            val code = q["code"]?.takeIf { CODE.matches(it) } ?: return null
            val api = q["api"]?.trimEnd('/') ?: return null
            val apiUri = try {
                URI(api)
            } catch (e: Exception) {
                return null
            }
            val secure = apiUri.scheme == "https" && !apiUri.host.isNullOrEmpty()
            val local = allowInsecureLocal && apiUri.scheme == "http" && apiUri.host in LOCAL_HOSTS
            if (!secure && !local) return null
            return PairingLink(api, code)
        }
    }
}

class ApiClient(
    private val http: OkHttpClient,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val json = "application/json".toMediaType()

    fun enroll(link: PairingLink, label: String, model: String, androidVersion: String, appVersion: String): EnrollResult {
        val body = JSONObject()
            .put("pairing_code", link.code)
            .put(
                "device_info",
                JSONObject().put("label", label.take(60)).put("model", model.take(60))
                    .put("android_version", androidVersion.take(20)).put("app_version", appVersion.take(20)),
            ).toString()
        val req = Request.Builder().url(link.apiBase + "/device/v1/enroll").post(body.toRequestBody(json)).build()
        val (status, text) = execute(req)
        if (status != 201) throw error(status, text)
        val o = JSONObject(text)
        return EnrollResult(o.getString("device_id"), o.getString("device_secret"), o.getString("location_id"), o.optBoolean("livemode"))
    }

    fun sendSignals(creds: Credentials, items: List<OutboxSignal>): List<SignalResult> {
        val arr = JSONArray()
        for (s in items) {
            val o = JSONObject()
                .put("app", s.app)
                .put("amount_paise", s.amountPaise)
                .put("posted_at", s.postedAt)
                .put("notification_key_hash", s.keyHash)
            if (s.payerShort != null) o.put("payer_short", s.payerShort)
            if (s.reference != null) o.put("reference", s.reference)
            if (s.rulesVersion.isNotEmpty()) o.put("rules_version", s.rulesVersion.take(40))
            arr.put(o)
        }
        val (status, text) = signed(creds, "POST", "/device/v1/signals", JSONObject().put("signals", arr).toString())
        if (status != 200) throw error(status, text)
        val results = JSONObject(text).getJSONArray("results")
        return (0 until results.length()).map {
            val r = results.getJSONObject(it)
            SignalResult(r.optBoolean("ok"), r.optStringOrNull("signal_id"), r.optStringOrNull("status"), r.optBoolean("repeat"), r.optStringOrNull("code"))
        }
    }

    fun heartbeat(creds: Credentials, listenerConnected: Boolean, appVersion: String, queueSize: Int, batteryOptimized: Boolean) {
        val body = JSONObject()
            .put("device_time", clock())
            .put("listener_connected", listenerConnected)
            .put("app_version", appVersion.take(20))
            .put("queue_size", queueSize)
            .put("battery_optimized", batteryOptimized)
            .toString()
        val (status, text) = signed(creds, "POST", "/device/v1/heartbeat", body)
        if (status != 200) throw error(status, text)
    }

    /** Returns the rules JSON, or null when our version is current (304) or none are published (404). */
    fun parserRules(creds: Credentials, currentVersion: String?): String? {
        val path = "/device/v1/parser_rules" + if (currentVersion.isNullOrEmpty()) "" else "?version=" + java.net.URLEncoder.encode(currentVersion, "UTF-8")
        val (status, text) = signed(creds, "GET", path, null)
        return when (status) {
            200 -> text
            304, 404 -> null
            else -> throw error(status, text)
        }
    }

    private fun signed(creds: Credentials, method: String, path: String, body: String?): Pair<Int, String> {
        val timestamp = (clock() / 1000).toString()
        val nonce = Signer.nonce()
        val signature = Signer.sign(creds.secret, method, path, timestamp, nonce, body ?: "")
        val builder = Request.Builder()
            .url(creds.apiBase + path)
            .header("x-device-id", creds.deviceId)
            .header("x-timestamp", timestamp)
            .header("x-nonce", nonce)
            .header("x-signature", signature)
        if (method == "GET") builder.get() else builder.method(method, (body ?: "").toRequestBody(json))
        return execute(builder.build())
    }

    private fun execute(req: Request): Pair<Int, String> = http.newCall(req).execute().use { it.code to (it.body?.string() ?: "") }

    private fun error(status: Int, text: String): ApiException {
        val code = try {
            JSONObject(text).optJSONObject("error")?.optString("code")
        } catch (e: Exception) {
            null
        }
        return ApiException(status, code, "HTTP $status${if (code != null) " ($code)" else ""}")
    }

    private fun JSONObject.optStringOrNull(key: String): String? = if (isNull(key) || !has(key)) null else optString(key)

    companion object {
        /** HTTPS client; optional certificate pinning for one host ("sha256/..." pins, primary + backup). */
        fun httpClient(pinHost: String, pins: String): OkHttpClient {
            val b = OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .callTimeout(20, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
            val pinList = pins.split(",").map { it.trim() }.filter { it.startsWith("sha256/") }
            if (pinHost.isNotEmpty() && pinList.isNotEmpty()) {
                b.certificatePinner(CertificatePinner.Builder().apply { pinList.forEach { add(pinHost, it) } }.build())
            }
            return b.build()
        }
    }
}
