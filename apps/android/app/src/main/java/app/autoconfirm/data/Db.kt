package app.autoconfirm.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

/** A parsed payment waiting to be sent. Only parsed fields: never the notification text. Deleted after a 2xx. */
@Entity(tableName = "outbox")
data class OutboxSignal(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val recentId: Long,
    val app: String,
    val amountPaise: Long,
    val payerShort: String?,
    val reference: String?,
    val postedAt: Long,
    val keyHash: String,
    val rulesVersion: String,
)

/** Today's list on the status screen, and the source for on-device dedupe. Kept 24 h. */
@Entity(tableName = "recent", indices = [Index("keyHash"), Index("postedAt")])
data class RecentPayment(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val app: String,
    val amountPaise: Long,
    val payerShort: String?,
    val postedAt: Long,
    val keyHash: String,
    /** waiting | matched | unmatched | ambiguous | review | duplicate | ignored | rejected */
    val status: String,
    val signalId: String? = null,
)

@Dao
interface PaymentDao {
    @Insert suspend fun insertRecent(r: RecentPayment): Long
    @Insert suspend fun insertOutbox(o: OutboxSignal): Long

    @Query("SELECT * FROM outbox ORDER BY id LIMIT :limit")
    suspend fun pending(limit: Int): List<OutboxSignal>

    @Query("DELETE FROM outbox WHERE id IN (:ids)")
    suspend fun deleteOutbox(ids: List<Long>)

    @Query("SELECT COUNT(*) FROM outbox")
    suspend fun outboxCount(): Int

    @Query("SELECT COUNT(*) FROM outbox")
    fun outboxCountFlow(): Flow<Int>

    @Query("UPDATE recent SET status = :status, signalId = :signalId WHERE id = :id")
    suspend fun updateRecent(id: Long, status: String, signalId: String?)

    /** Same notification key and amount within the window: the app updated its notification. */
    @Query("SELECT COUNT(*) FROM recent WHERE keyHash = :keyHash AND amountPaise = :amount AND postedAt BETWEEN :from AND :to")
    suspend fun countSame(keyHash: String, amount: Long, from: Long, to: Long): Int

    @Query("SELECT * FROM recent WHERE postedAt >= :since ORDER BY postedAt DESC")
    fun recentFlow(since: Long): Flow<List<RecentPayment>>

    @Query("DELETE FROM recent WHERE postedAt < :before")
    suspend fun pruneRecent(before: Long)
}

@Database(entities = [OutboxSignal::class, RecentPayment::class], version = 1, exportSchema = false)
abstract class AppDb : RoomDatabase() {
    abstract fun payments(): PaymentDao

    companion object {
        fun create(context: Context): AppDb = Room.databaseBuilder(context, AppDb::class.java, "autoconfirm.db").build()
    }
}
