package app.dunia.chat

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import org.json.JSONArray
import org.json.JSONObject

/** Play Store build: Google Play Billing Library 8. */
object StoreFactory {
    fun create(context: Context): Store = PlayStore(context.applicationContext)
}

private class PlayStore(context: Context) : Store, PurchasesUpdatedListener {
    override val billing = true

    // Google Play's Payments policy: in-app digital goods sold in a Play-distributed
    // app must use Play Billing. (Offering UPI next to it needs enrolment in Google's
    // user choice billing program plus its dedicated API — not enabled here.)
    override val upiAllowed = false

    private val main = Handler(Looper.getMainLooper())
    private val details = mutableMapOf<String, ProductDetails>()
    private var buying: ((Result<JSONObject>) -> Unit)? = null
    private val waiting = mutableListOf<(Boolean) -> Unit>()
    private var connecting = false

    private val client: BillingClient = BillingClient.newBuilder(context)
        .setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .build()

    /** Connects on demand and reconnects after the Play service drops. */
    private fun ready(then: (Boolean) -> Unit) {
        if (client.isReady) return then(true)
        waiting += then
        if (connecting) return
        connecting = true
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) = flush(result.responseCode == BillingResponseCode.OK)
            override fun onBillingServiceDisconnected() = flush(false)
        })
    }

    private fun flush(ok: Boolean) {
        main.post {
            connecting = false
            val list = waiting.toList()
            waiting.clear()
            list.forEach { it(ok) }
        }
    }

    override fun products(ids: List<String>, done: (Result<JSONArray>) -> Unit) = ready { ok ->
        if (!ok) return@ready done(Result.failure(StoreException("unavailable")))
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(ids.map {
                QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(ProductType.INAPP).build()
            })
            .build()
        client.queryProductDetailsAsync(params) { result, productDetailsResult ->
            main.post {
                if (result.responseCode != BillingResponseCode.OK) return@post done(Result.failure(StoreException("unavailable")))
                val out = JSONArray()
                for (pd in productDetailsResult.productDetailsList) {
                    details[pd.productId] = pd
                    val price = pd.oneTimePurchaseOfferDetails?.formattedPrice ?: continue
                    out.put(JSONObject().put("productId", pd.productId).put("price", price).put("title", pd.name))
                }
                done(Result.success(out))
            }
        }
    }

    override fun buy(activity: Activity, productId: String, accountId: String, done: (Result<JSONObject>) -> Unit) {
        val pd = details[productId] ?: return done(Result.failure(StoreException("unavailable")))
        if (buying != null) return done(Result.failure(StoreException("busy")))
        ready { ok ->
            if (!ok) return@ready done(Result.failure(StoreException("unavailable")))
            val params = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(pd).build()))
                // Ties the purchase to this Dunia device; the server checks it matches.
                .setObfuscatedAccountId(accountId)
                .build()
            buying = done
            val r = client.launchBillingFlow(activity, params)
            if (r.responseCode != BillingResponseCode.OK) finishBuy(Result.failure(StoreException(codeOf(r))))
        }
    }

    override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
        val p = purchases?.firstOrNull()
        when {
            result.responseCode == BillingResponseCode.OK && p != null && p.purchaseState == Purchase.PurchaseState.PURCHASED ->
                finishBuy(Result.success(p.toJson()))
            result.responseCode == BillingResponseCode.OK && p != null && p.purchaseState == Purchase.PurchaseState.PENDING ->
                finishBuy(Result.failure(StoreException("pending")))
            else -> finishBuy(Result.failure(StoreException(codeOf(result))))
        }
    }

    private fun finishBuy(r: Result<JSONObject>) {
        main.post {
            val cb = buying
            buying = null
            cb?.invoke(r)
        }
    }

    override fun consume(purchaseToken: String, done: (Result<Boolean>) -> Unit) = ready { ok ->
        if (!ok) return@ready done(Result.failure(StoreException("unavailable")))
        client.consumeAsync(ConsumeParams.newBuilder().setPurchaseToken(purchaseToken).build()) { r, _ ->
            main.post { done(Result.success(r.responseCode == BillingResponseCode.OK)) }
        }
    }

    override fun pending(done: (Result<JSONArray>) -> Unit) = ready { ok ->
        if (!ok) return@ready done(Result.success(JSONArray()))
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(ProductType.INAPP).build()) { _, list ->
            val out = JSONArray()
            list.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }.forEach { out.put(it.toJson()) }
            main.post { done(Result.success(out)) }
        }
    }

    override fun close() = client.endConnection()

    private fun Purchase.toJson() = JSONObject()
        .put("productId", products.firstOrNull() ?: "")
        .put("purchaseToken", purchaseToken)
        .put("orderId", orderId ?: "")

    private fun codeOf(r: BillingResult) = when (r.responseCode) {
        BillingResponseCode.USER_CANCELED -> "cancelled"
        BillingResponseCode.ITEM_ALREADY_OWNED -> "owned"
        BillingResponseCode.SERVICE_UNAVAILABLE, BillingResponseCode.SERVICE_DISCONNECTED,
        BillingResponseCode.BILLING_UNAVAILABLE -> "unavailable"
        else -> "error"
    }
}
