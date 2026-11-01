package app.autoconfirm.work

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import app.autoconfirm.R
import app.autoconfirm.app
import app.autoconfirm.ui.MainActivity

/**
 * Warns on the counter phone itself when it can't see payments (notification access turned off).
 * The server also alerts the owner when the phone stops checking in; this catches it on the spot.
 */
object Health {
    private const val CHANNEL = "health"
    private const val NOTIFICATION_ID = 1001

    /** Pure rule, unit-tested: warn only for a paired, unpaused phone whose notification access is off. */
    fun needsWarning(paired: Boolean, paused: Boolean, listenerOn: Boolean): Boolean = paired && !paused && !listenerOn

    fun check(ctx: Context) {
        val a = ctx.app
        if (needsWarning(a.store.isPaired, a.store.paused, Sync.listenerEnabled(ctx))) warn(ctx) else clear(ctx)
    }

    fun canNotify(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun warn(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Problems with AutoConfirm", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Tells you when this phone can't see payments."
            },
        )
        if (!canNotify(ctx)) return
        val open = PendingIntent.getActivity(
            ctx,
            0,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setContentTitle("AutoConfirm can't see payments")
            .setContentText("Notification access is off. Tap to turn it back on.")
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_ERROR)
            .build()
        nm.notify(NOTIFICATION_ID, n)
    }

    fun clear(ctx: Context) {
        ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }
}
