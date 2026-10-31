package app.autoconfirm.data

import android.content.Context
import app.autoconfirm.parse.ParserRules
import app.autoconfirm.security.KeystoreCipher

/** Device credentials and small state. The device secret is stored encrypted with a Keystore key. */
data class Credentials(val apiBase: String, val deviceId: String, val secret: String)

class Store(context: Context) {
    private val p = context.getSharedPreferences("autoconfirm", Context.MODE_PRIVATE)

    val isPaired: Boolean get() = p.contains("device_id") && !revoked
    val deviceId: String? get() = p.getString("device_id", null)
    val locationId: String? get() = p.getString("location_id", null)
    val apiBase: String? get() = p.getString("api_base", null)
    val livemode: Boolean get() = p.getBoolean("livemode", false)

    var paused: Boolean
        get() = p.getBoolean("paused", false)
        set(v) = p.edit().putBoolean("paused", v).apply()

    /** Set when the server rejects our credentials (phone removed in the dashboard). */
    var revoked: Boolean
        get() = p.getBoolean("revoked", false)
        set(v) = p.edit().putBoolean("revoked", v).apply()

    var lastHeartbeatOkAt: Long
        get() = p.getLong("last_heartbeat_ok", 0)
        set(v) = p.edit().putLong("last_heartbeat_ok", v).apply()

    var lastError: String?
        get() = p.getString("last_error", null)
        set(v) = p.edit().putString("last_error", v).apply()

    var parseFailures: Int
        get() = p.getInt("parse_failures", 0)
        set(v) = p.edit().putInt("parse_failures", v).apply()

    var rulesCheckedAt: Long
        get() = p.getLong("rules_checked_at", 0)
        set(v) = p.edit().putLong("rules_checked_at", v).apply()

    fun savePairing(apiBase: String, deviceId: String, secret: String, locationId: String, livemode: Boolean) {
        p.edit()
            .putString("api_base", apiBase)
            .putString("device_id", deviceId)
            .putString("secret_enc", KeystoreCipher.encrypt(secret))
            .putString("location_id", locationId)
            .putBoolean("livemode", livemode)
            .putBoolean("revoked", false)
            .apply()
    }

    fun credentials(): Credentials? {
        if (!isPaired) return null
        val base = apiBase ?: return null
        val id = deviceId ?: return null
        val enc = p.getString("secret_enc", null) ?: return null
        val secret = try {
            KeystoreCipher.decrypt(enc)
        } catch (e: Exception) {
            return null
        }
        return Credentials(base, id, secret)
    }

    @Volatile private var cachedRules: ParserRules? = null

    fun rules(): ParserRules? {
        cachedRules?.let { return it }
        val json = p.getString("rules_json", null) ?: return null
        return try {
            ParserRules.parse(json).also { cachedRules = it }
        } catch (e: Exception) {
            null
        }
    }

    fun saveRules(json: String) {
        val parsed = ParserRules.parse(json) // validate before saving
        p.edit().putString("rules_json", json).apply()
        cachedRules = parsed
    }

    fun clear() {
        p.edit().clear().apply()
        cachedRules = null
        runCatching { KeystoreCipher.deleteKey() }
    }
}
