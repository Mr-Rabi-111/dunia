package app.dunia.chat

import android.app.Activity
import org.json.JSONArray
import org.json.JSONObject

/**
 * In-app purchases, as seen by the web app through the bridge.
 *
 *  - `play` flavor   → Google Play Billing (PlayStore.kt). Required for the Play Store.
 *  - `direct` flavor → no store; the web app shows its UPI checkout (DirectStore.kt).
 *
 * The server always verifies a purchase before granting Premium; the app never
 * decides on its own that something was paid.
 */
interface Store {
    /** True when this build sells through Google Play Billing. */
    val billing: Boolean

    /** True when the web app may offer UPI (never in the Play build). */
    val upiAllowed: Boolean

    /** [{ productId, price, title }] for the given product ids. */
    fun products(ids: List<String>, done: (Result<JSONArray>) -> Unit)

    /** Opens the Play purchase sheet. Result: { productId, purchaseToken, orderId }. */
    fun buy(activity: Activity, productId: String, accountId: String, done: (Result<JSONObject>) -> Unit)

    /** Consumes a pass after the server granted it, so it can be bought again. */
    fun consume(purchaseToken: String, done: (Result<Boolean>) -> Unit)

    /** Completed purchases not consumed yet (e.g. the app was closed mid-purchase). */
    fun pending(done: (Result<JSONArray>) -> Unit)

    fun close() {}
}

/** Error with a short code the web app understands: cancelled, pending, unavailable, … */
class StoreException(val code: String) : Exception(code)
