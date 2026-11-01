package app.autoconfirm.work

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.autoconfirm.app
import java.util.concurrent.TimeUnit

/** Every 15 min (Android's minimum) and whenever a send fails: refresh rules, send the queue, heartbeat. */
class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        if (!ctx.app.store.isPaired) return Result.success()
        Health.check(ctx)
        return try {
            runCatching { Sync.refreshRules(ctx) }
            Sync.flush(ctx)
            Sync.heartbeat(ctx)
            Sync.pruneRecent(ctx)
            Result.success()
        } catch (e: Exception) {
            if (ctx.app.store.revoked) Result.success() else Result.retry()
        }
    }

    companion object {
        private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedule(ctx: Context) {
            val periodic = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(network).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("sync", ExistingPeriodicWorkPolicy.KEEP, periodic)
        }

        /** Retry soon after a failed send; runs as soon as the network is back. */
        fun runSoon(ctx: Context) {
            val once = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(network)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork("sync-now", ExistingWorkPolicy.REPLACE, once)
        }

        fun cancelAll(ctx: Context) = WorkManager.getInstance(ctx).cancelAllWork()
    }
}

/** Re-schedules work after a reboot or an app update. The system rebinds the listener itself. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            if (context.app.store.isPaired) {
                Health.check(context)
                SyncWorker.schedule(context)
                SyncWorker.runSoon(context)
            }
        }
    }
}
