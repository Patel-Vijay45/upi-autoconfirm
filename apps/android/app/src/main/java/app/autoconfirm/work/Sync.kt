package app.autoconfirm.work

import android.content.Context
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import app.autoconfirm.BuildConfig
import app.autoconfirm.app
import app.autoconfirm.data.OutboxSignal
import app.autoconfirm.data.RecentPayment
import app.autoconfirm.net.ApiException
import app.autoconfirm.net.Signer
import app.autoconfirm.parse.ParseResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Sending, heartbeats and rule refresh. Shared by the listener service and the periodic worker. */
object Sync {
    private val flushLock = Mutex()
    private const val DEDUPE_WINDOW_MS = 2 * 60_000L
    private const val RULES_EVERY_MS = 15 * 60_000L

    /** A parsed notification: dedupe on the phone, queue it (survives no-internet and restarts), then send. */
    suspend fun intake(ctx: Context, result: ParseResult, notificationKey: String, postedAt: Long, rulesVersion: String) = withContext(Dispatchers.IO) {
        val a = ctx.app
        when (result) {
            is ParseResult.Payment -> {
                val dao = a.db.payments()
                val keyHash = Signer.keyHash(notificationKey)
                // The same notification updated (same key + amount within 2 min) is not a new payment.
                if (dao.countSame(keyHash, result.amountPaise, postedAt - DEDUPE_WINDOW_MS, postedAt + DEDUPE_WINDOW_MS) > 0) return@withContext
                val recentId = dao.insertRecent(
                    RecentPayment(app = result.app, amountPaise = result.amountPaise, payerShort = result.payerShort, postedAt = postedAt, keyHash = keyHash, status = "waiting"),
                )
                dao.insertOutbox(
                    OutboxSignal(
                        recentId = recentId, app = result.app, amountPaise = result.amountPaise, payerShort = result.payerShort,
                        reference = result.reference, postedAt = postedAt, keyHash = keyHash, rulesVersion = rulesVersion,
                    ),
                )
                runCatching { flush(ctx) }.onFailure { SyncWorker.runSoon(ctx) }
            }
            is ParseResult.Failed -> a.store.parseFailures = a.store.parseFailures + 1
            else -> Unit
        }
    }

    /** Sends everything queued, oldest first, 50 at a time. Throws on network/server errors (caller retries). */
    suspend fun flush(ctx: Context) = withContext(Dispatchers.IO) {
        flushLock.withLock {
            val a = ctx.app
            val creds = a.store.credentials() ?: return@withLock
            val dao = a.db.payments()
            while (true) {
                val batch = dao.pending(50)
                if (batch.isEmpty()) break
                val results = try {
                    a.api.sendSignals(creds, batch)
                } catch (e: ApiException) {
                    handleApiError(ctx, e)
                    if (e.status in 400..499 && !e.isAuthFailure && e.code != "replayed_nonce") {
                        // The server rejected the batch as invalid; drop it so one bad item can't block the queue.
                        dao.deleteOutbox(batch.map { it.id })
                        batch.forEach { dao.updateRecent(it.recentId, "rejected", null) }
                        continue
                    }
                    throw e
                }
                batch.zip(results).forEach { (item, r) -> dao.updateRecent(item.recentId, if (r.ok) r.status ?: "sent" else "rejected", r.signalId) }
                dao.deleteOutbox(batch.map { it.id })
                a.store.lastError = null
            }
        }
    }

    suspend fun heartbeat(ctx: Context) = withContext(Dispatchers.IO) {
        val a = ctx.app
        val creds = a.store.credentials() ?: return@withContext
        try {
            a.api.heartbeat(
                creds,
                listenerConnected = listenerEnabled(ctx),
                appVersion = BuildConfig.VERSION_NAME,
                queueSize = a.db.payments().outboxCount(),
                batteryOptimized = !ignoringBatteryOptimizations(ctx),
            )
            a.store.lastHeartbeatOkAt = System.currentTimeMillis()
            a.store.lastError = null
        } catch (e: ApiException) {
            handleApiError(ctx, e)
            throw e
        }
    }

    suspend fun refreshRules(ctx: Context, force: Boolean = false) = withContext(Dispatchers.IO) {
        val a = ctx.app
        if (!force && System.currentTimeMillis() - a.store.rulesCheckedAt < RULES_EVERY_MS) return@withContext
        val creds = a.store.credentials() ?: return@withContext
        val current = a.store.rules()?.version
        val json = try {
            a.api.parserRules(creds, current)
        } catch (e: ApiException) {
            handleApiError(ctx, e)
            throw e
        }
        if (json != null) a.store.saveRules(json)
        a.store.rulesCheckedAt = System.currentTimeMillis()
    }

    suspend fun pruneRecent(ctx: Context) = withContext(Dispatchers.IO) {
        ctx.app.db.payments().pruneRecent(System.currentTimeMillis() - 24 * 3600_000L)
    }

    private fun handleApiError(ctx: Context, e: ApiException) {
        val store = ctx.app.store
        store.lastError = e.message
        if (e.isAuthFailure) store.revoked = true // removed in the dashboard: stop sending
    }

    fun listenerEnabled(ctx: Context): Boolean = NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)

    fun ignoringBatteryOptimizations(ctx: Context): Boolean =
        (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(ctx.packageName)
}
