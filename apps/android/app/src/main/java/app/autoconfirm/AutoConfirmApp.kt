package app.autoconfirm

import android.app.Application
import android.content.Context
import app.autoconfirm.data.AppDb
import app.autoconfirm.data.Store
import app.autoconfirm.net.ApiClient
import app.autoconfirm.work.SyncWorker

class AutoConfirmApp : Application() {
    lateinit var store: Store
        private set
    lateinit var db: AppDb
        private set
    lateinit var api: ApiClient
        private set

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        db = AppDb.create(this)
        api = ApiClient(ApiClient.httpClient(BuildConfig.PIN_HOST, BuildConfig.PIN_SHA256))
        if (store.isPaired) SyncWorker.schedule(this)
    }
}

val Context.app: AutoConfirmApp get() = applicationContext as AutoConfirmApp
