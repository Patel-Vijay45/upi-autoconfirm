package app.autoconfirm.net

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Device request signing (docs/API.md §8), byte-for-byte the same as the server:
 * X-Signature = hex(HMAC_SHA256(secret, METHOD \n path \n timestamp \n nonce \n sha256_hex(body)))
 */
object Signer {
    private val random = SecureRandom()

    fun sha256Hex(data: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(data).toHex()

    fun hmacHex(secret: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(message.toByteArray(Charsets.UTF_8)).toHex()
    }

    fun sign(secret: String, method: String, path: String, timestamp: String, nonce: String, body: String): String =
        hmacHex(secret, listOf(method.uppercase(), path, timestamp, nonce, sha256Hex(body.toByteArray(Charsets.UTF_8))).joinToString("\n"))

    fun nonce(): String {
        val b = ByteArray(16)
        random.nextBytes(b)
        return "n_" + b.toHex()
    }

    /** Notification keys are hashed before they leave the phone. */
    fun keyHash(notificationKey: String): String = sha256Hex(notificationKey.toByteArray(Charsets.UTF_8)).take(32)

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
