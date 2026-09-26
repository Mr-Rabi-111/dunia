package app.dunia.chat

import android.app.Activity
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Direct-download build: no Google Play Billing. The web app uses its UPI checkout. */
object StoreFactory {
    fun create(@Suppress("UNUSED_PARAMETER") context: Context): Store = DirectStore
}

private object DirectStore : Store {
    override val billing = false
    override val upiAllowed = true
    override fun products(ids: List<String>, done: (Result<JSONArray>) -> Unit) = done(Result.success(JSONArray()))
    override fun buy(activity: Activity, productId: String, accountId: String, done: (Result<JSONObject>) -> Unit) =
        done(Result.failure(StoreException("unavailable")))
    override fun consume(purchaseToken: String, done: (Result<Boolean>) -> Unit) = done(Result.success(false))
    override fun pending(done: (Result<JSONArray>) -> Unit) = done(Result.success(JSONArray()))
}
