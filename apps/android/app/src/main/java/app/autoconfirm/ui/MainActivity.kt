package app.autoconfirm.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.activity.result.contract.ActivityResultContracts
import app.autoconfirm.work.Health
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import app.autoconfirm.BuildConfig
import app.autoconfirm.app
import app.autoconfirm.data.RecentPayment
import app.autoconfirm.net.PairingLink
import app.autoconfirm.parse.Money
import app.autoconfirm.work.Sync
import app.autoconfirm.work.SyncWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {
    private var incomingLink by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        incomingLink = intent?.data?.toString()
        setContent {
            val dark = isSystemInDarkTheme()
            MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) { Root(incomingLink) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        incomingLink = intent.data?.toString()
    }
}

@Composable
private fun Root(incomingLink: String?) {
    val ctx = LocalLifecycleOwner.current
    val context = androidx.compose.ui.platform.LocalContext.current
    val app = context.app
    var tick by remember { mutableIntStateOf(0) }
    // Re-read settings state whenever the screen is visible (permissions change in system settings).
    // While the app is on screen it also checks in every 30 s, so a phone removed in the dashboard
    // shows "removed" here right away (in the background it checks every 5 min to save battery).
    LaunchedEffect(ctx) {
        ctx.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            var lastCheck = 0L
            while (true) {
                if (System.currentTimeMillis() - lastCheck >= 30_000) {
                    lastCheck = System.currentTimeMillis()
                    Health.check(context) // clears the "can't see payments" warning once fixed
                    if (app.store.isPaired) launch { runCatching { Sync.heartbeat(context) } }
                }
                tick++
                delay(2_000)
            }
        }
    }
    @Suppress("UNUSED_EXPRESSION") tick
    // Demo: look around without a shop (for Google Play reviewers and curious owners). Nothing is read or sent.
    var demo by rememberSaveable { mutableStateOf(false) }
    when {
        app.store.isPaired -> StatusScreen(tick) { tick++ }
        demo && incomingLink == null -> DemoScreen(tick) { demo = false }
        else -> PairScreen(incomingLink, app.store.revoked, onDemo = { demo = true }) { tick++ }
    }
}

@Composable
private fun PairScreen(incomingLink: String?, wasRevoked: Boolean, onDemo: () -> Unit, onPaired: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var link by remember(incomingLink) { mutableStateOf(incomingLink ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Scaffold { pad ->
        Column(Modifier.padding(pad).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("AutoConfirm", fontSize = 28.sp, fontWeight = FontWeight.Bold)
            Text("Confirms UPI payments to your shop automatically. Money goes straight to your bank; this app only reports \"money received\" alerts.")
            if (wasRevoked) Text("This phone was removed from the dashboard. Pair it again to continue.", color = MaterialTheme.colorScheme.error)
            Text("1. In the dashboard, open your location and tap Add phone.\n2. Scan the QR with this phone's camera, or paste the link below.")
            OutlinedTextField(
                value = link,
                onValueChange = { link = it; error = null },
                label = { Text("Pairing link (autoconfirm://pair?…)") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                enabled = !busy && link.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                onClick = {
                    val parsed = PairingLink.parse(link, allowInsecureLocal = BuildConfig.DEBUG)
                    if (parsed == null) {
                        error = "That isn't a valid pairing link."
                        return@Button
                    }
                    busy = true
                    scope.launch {
                        try {
                            val a = context.app
                            val r = withContext(Dispatchers.IO) {
                                a.api.enroll(parsed, "${Build.MANUFACTURER} ${Build.MODEL}", Build.MODEL, Build.VERSION.RELEASE, BuildConfig.VERSION_NAME)
                            }
                            a.store.savePairing(parsed.apiBase, r.deviceId, r.secret, r.locationId, r.livemode)
                            SyncWorker.schedule(context)
                            runCatching { Sync.refreshRules(context, force = true) }
                            runCatching { Sync.heartbeat(context) }
                            onPaired()
                        } catch (e: Exception) {
                            error = "Pairing failed: ${e.message ?: "network error"}. The code is valid for 10 minutes and works once."
                        } finally {
                            busy = false
                        }
                    }
                },
            ) { Text(if (busy) "Pairing…" else "Pair this phone") }
            TextButton(onClick = onDemo, modifier = Modifier.fillMaxWidth()) { Text("No shop yet? See how it works (demo)") }
            PrivacyLink()
        }
    }
}

/** Demo mode: the real checklist and permission flow, with sample payments. Not paired, so nothing is read or sent. */
@Composable
private fun DemoScreen(tick: Int, onExit: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var showDisclosure by remember { mutableStateOf(false) }
    @Suppress("UNUSED_EXPRESSION") tick
    val listenerOn = Sync.listenerEnabled(context)
    val now = remember { System.currentTimeMillis() }
    val samples = remember {
        listOf(
            RecentPayment(id = -1, app = "google_pay", amountPaise = 93007, payerShort = "Ramesh P", postedAt = now - 4 * 60_000, keyHash = "demo1", status = "matched"),
            RecentPayment(id = -2, app = "bank_sms", amountPaise = 45023, payerShort = null, postedAt = now - 19 * 60_000, keyHash = "demo2", status = "matched"),
            RecentPayment(id = -3, app = "google_pay", amountPaise = 6000, payerShort = "Sita K", postedAt = now - 41 * 60_000, keyHash = "demo3", status = "unmatched"),
        )
    }
    Scaffold { pad ->
        LazyColumn(Modifier.padding(pad).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Spacer(Modifier.size(8.dp))
                Text("Demo", fontSize = 24.sp, fontWeight = FontWeight.Bold)
                Text(
                    "This is what the counter phone shows. In demo mode the phone isn't connected to a shop, so no notifications are read and nothing is sent. The payments below are examples.",
                )
            }
            item { Text("Setup checklist", fontWeight = FontWeight.Bold, fontSize = 18.sp) }
            item { CheckItem("Notification access is ON", listenerOn, "Turn on") { showDisclosure = true } }
            item { CheckItem("Paired with your shop", false, null) {} }
            item { Text("Today (examples)", fontWeight = FontWeight.Bold, fontSize = 18.sp) }
            items(samples, key = { it.id }) { PaymentRow(it) }
            item {
                Spacer(Modifier.size(12.dp))
                OutlinedButton(onClick = onExit, modifier = Modifier.fillMaxWidth()) { Text("Exit demo") }
                PrivacyLink()
                Spacer(Modifier.size(24.dp))
            }
        }
    }
    if (showDisclosure) NotificationAccessDisclosure { showDisclosure = false }
}

/** Opens the privacy policy (Google Play requires a link inside the app). Hidden if the build has no URL. */
@Composable
private fun PrivacyLink() {
    val context = androidx.compose.ui.platform.LocalContext.current
    if (BuildConfig.PRIVACY_URL.isBlank()) return
    TextButton(
        onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.PRIVACY_URL))) } },
        modifier = Modifier.fillMaxWidth(),
    ) { Text("Privacy policy") }
}

/**
 * Prominent disclosure before asking for notification access (Google Play User Data policy): what is read,
 * what is sent and why, and an explicit "Agree" before the system settings screen opens.
 */
@Composable
private fun NotificationAccessDisclosure(onDismiss: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Allow notification access") },
        text = {
            Text(
                DISCLOSURE_TEXT,
            )
        },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }) { Text("Agree and continue") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Not now") } },
    )
}

/** Kept word for word in docs/PLAY-STORE.md (Google may ask for it). */
const val DISCLOSURE_TEXT =
    "AutoConfirm reads notifications on this phone to see when your shop receives money:\n" +
        "• alerts from the payment apps you use (like Google Pay, PhonePe Business, Paytm for Business), and\n" +
        "• bank \"credited\" SMS alerts shown by your messaging app, only from bank sender IDs.\n\n" +
        "From these it takes only the amount, time, a short payer name (\"Ramesh P\") and the payment reference, and sends them to your shop's AutoConfirm server to mark orders as paid.\n\n" +
        "Notifications from other apps, other SMS and the full notification text are never stored or sent. Nothing is read until this phone is paired with your shop. Your data is not sold or used for ads."

@Composable
private fun StatusScreen(tick: Int, refresh: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val a = context.app
    val scope = rememberCoroutineScope()
    val since = remember { System.currentTimeMillis() - 24 * 3600_000L }
    val recent by a.db.payments().recentFlow(since).collectAsState(initial = emptyList())
    val waiting by a.db.payments().outboxCountFlow().collectAsState(initial = 0)
    var showDisclosure by remember { mutableStateOf(false) }
    var confirmUnpair by remember { mutableStateOf(false) }
    val askNotify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refresh() }

    @Suppress("UNUSED_EXPRESSION") tick
    val listenerOn = Sync.listenerEnabled(context)
    val batteryOk = Sync.ignoringBatteryOptimizations(context)
    val rules = a.store.rules()
    val online = System.currentTimeMillis() - a.store.lastHeartbeatOkAt < 11 * 60_000L
    val testPaymentSeen = recent.any { it.status != "waiting" && it.status != "rejected" }
    val lastPayment = recent.firstOrNull()

    Scaffold { pad ->
        LazyColumn(Modifier.padding(pad).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Spacer(Modifier.size(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Dot(if (online && listenerOn && !a.store.paused) Color(0xFF2E7D32) else Color(0xFFC62828))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        when {
                            a.store.paused -> "Paused"
                            online && listenerOn -> "Online"
                            else -> "Offline"
                        },
                        fontSize = 24.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    if (!a.store.livemode) {
                        Spacer(Modifier.width(8.dp))
                        Text("TEST MODE", color = MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.Bold)
                    }
                }
                Text(
                    buildString {
                        append(if (lastPayment != null) "Last payment ${ago(lastPayment.postedAt)}" else "No payments yet today")
                        append(" · $waiting waiting to send")
                    },
                )
                a.store.lastError?.let { Text("Last error: $it", color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            }

            item { Text("Setup checklist", fontWeight = FontWeight.Bold, fontSize = 18.sp) }
            item {
                CheckItem("Notification access is ON", listenerOn, "Turn on") { showDisclosure = true }
            }
            if (Build.VERSION.SDK_INT >= 33) {
                item {
                    CheckItem("Warnings on this phone allowed (if it stops seeing payments)", Health.canNotify(context), "Allow") {
                        askNotify.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                    }
                }
            }
            item {
                CheckItem("Battery optimisation is OFF for AutoConfirm", batteryOk, "Fix") {
                    context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }
            item {
                CheckItem("Autostart allowed (Xiaomi, Oppo, Vivo, Realme)", null, "Open settings") {
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
                }
            }
            item {
                CheckItem("Payment-app rules loaded${rules?.version?.let { " ($it)" } ?: ""}", rules != null && rules.apps.isNotEmpty(), "Retry") {
                    scope.launch { runCatching { Sync.refreshRules(context, force = true) }; refresh() }
                }
            }
            item {
                CheckItem("Test payment: send ₹1 to your own UPI ID from another phone", testPaymentSeen, null) {}
            }
            if (a.store.parseFailures > 0) {
                item { Text("${a.store.parseFailures} payment alerts could not be read. They will work once the rules are updated.", fontSize = 13.sp) }
            }

            item {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Text("Pause sending", modifier = Modifier.weight(1f))
                    Switch(checked = a.store.paused, onCheckedChange = { a.store.paused = it; refresh() })
                }
            }

            item { Text("Today", fontWeight = FontWeight.Bold, fontSize = 18.sp) }
            if (recent.isEmpty()) item { Text("Payments received on this phone will appear here.") }
            items(recent, key = { it.id }) { PaymentRow(it) }

            item {
                Spacer(Modifier.size(12.dp))
                OutlinedButton(onClick = { confirmUnpair = true }, modifier = Modifier.fillMaxWidth()) { Text("Unpair this phone") }
                PrivacyLink()
                Spacer(Modifier.size(24.dp))
            }
        }
    }

    if (showDisclosure) NotificationAccessDisclosure { showDisclosure = false }
    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this phone?") },
            text = { Text("Payments will no longer be confirmed from this phone until you pair it again.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    SyncWorker.cancelAll(context)
                    scope.launch {
                        withContext(Dispatchers.IO) {
                            // Tell the server first (best effort: if offline, remove the phone in the dashboard).
                            a.store.credentials()?.let { creds -> runCatching { a.api.unpair(creds) } }
                            a.db.clearAllTables()
                        }
                        a.store.clear()
                        Health.clear(context)
                        refresh()
                    }
                }) { Text("Unpair") }
            },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun CheckItem(label: String, ok: Boolean?, action: String?, onAction: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                when (ok) {
                    true -> "✓"
                    false -> "✗"
                    null -> "•"
                },
                color = when (ok) {
                    true -> Color(0xFF2E7D32)
                    false -> Color(0xFFC62828)
                    null -> MaterialTheme.colorScheme.onSurfaceVariant
                },
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.width(12.dp))
            Text(label, modifier = Modifier.weight(1f))
            if (action != null && ok != true) Button(onClick = onAction) { Text(action) }
        }
    }
}

@Composable
private fun PaymentRow(p: RecentPayment) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("₹${Money.format(p.amountPaise)}", fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                Text(statusLabel(p.status), color = statusColor(p.status), fontWeight = FontWeight.Bold)
            }
            Text("${time(p.postedAt)} · ${p.payerShort ?: "Unknown payer"} · ${p.app}", fontSize = 13.sp)
        }
    }
}

private fun statusLabel(s: String) = when (s) {
    "waiting" -> "Waiting to send"
    "matched" -> "Order paid ✓"
    "review" -> "Staff to confirm"
    "unmatched", "ambiguous" -> "In inbox"
    "duplicate" -> "Duplicate"
    "ignored" -> "Ignored"
    "rejected" -> "Not accepted"
    else -> s
}

@Composable
private fun statusColor(s: String) = when (s) {
    "matched" -> Color(0xFF2E7D32)
    "waiting", "review", "unmatched", "ambiguous" -> Color(0xFFEF6C00)
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun Dot(color: Color) {
    androidx.compose.foundation.Canvas(Modifier.size(14.dp)) { drawCircle(color) }
}

private fun time(ms: Long) = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(ms))

private fun ago(ms: Long): String {
    val min = (System.currentTimeMillis() - ms) / 60_000
    return when {
        min < 1 -> "just now"
        min < 60 -> "$min min ago"
        else -> "${min / 60} h ago"
    }
}
