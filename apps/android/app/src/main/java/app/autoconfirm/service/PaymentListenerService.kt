package app.autoconfirm.service

import android.app.Notification
import android.content.ComponentName
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import app.autoconfirm.app
import app.autoconfirm.parse.NotificationParser
import app.autoconfirm.parse.ParseResult
import app.autoconfirm.work.Sync
import app.autoconfirm.work.SyncWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Reads "money received" notifications from payment apps listed in the parser rules.
 * Every other app's notification is dropped at the first line; nothing from it is read or stored.
 * While the listener is connected it sends a heartbeat every 5 min, so a killed app shows up as "offline".
 */
class PaymentListenerService : NotificationListenerService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var heartbeat: Job? = null

    override fun onListenerConnected() {
        heartbeat?.cancel()
        heartbeat = scope.launch {
            runCatching { Sync.refreshRules(this@PaymentListenerService) }
            while (isActive) {
                runCatching { Sync.flush(this@PaymentListenerService) }
                runCatching { Sync.heartbeat(this@PaymentListenerService) }
                delay(5 * 60_000L)
            }
        }
    }

    override fun onListenerDisconnected() {
        heartbeat?.cancel()
        requestRebind(ComponentName(this, PaymentListenerService::class.java))
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val a = applicationContext.app
        if (!a.store.isPaired || a.store.paused) return
        val rules = a.store.rules() ?: return
        if (rules.forPackage(sbn.packageName) == null) return // not a payment app: ignore immediately
        val n = sbn.notification ?: return
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        val extras = n.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
        val big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString() ?: ""
        val result = NotificationParser.parse(rules, sbn.packageName, title, text, big)
        if (result is ParseResult.Payment || result is ParseResult.Failed) {
            scope.launch {
                runCatching { Sync.intake(applicationContext, result, sbn.key, sbn.postTime, rules.version) }
                    .onFailure { SyncWorker.runSoon(applicationContext) }
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
