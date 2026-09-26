package app.dunia.chat

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/**
 * Dunia for Android: a thin, fast native shell around the Dunia web app.
 *
 *  - Camera & microphone: Android runtime permissions, then granted to the page
 *    (only for Dunia's own origin).
 *  - Payments: Google Play Billing (play flavor) or UPI apps via upi:// links
 *    (direct flavor), exposed to the page through a private message bridge.
 *  - Back button, keep-screen-on during calls, share sheet, invite App Links,
 *    edge-to-edge layout with the keyboard, offline screen.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var store: Store
    private val baseUri: Uri = Uri.parse(BuildConfig.BASE_URL)
    private val origin: String = "${baseUri.scheme}://${baseUri.authority}"
    private var pendingWebPermission: PermissionRequest? = null
    private var offline = false

    private val askMedia = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        val req = pendingWebPermission ?: return@registerForActivityResult
        pendingWebPermission = null
        grantAllowed(req, grants.filterValues { it }.keys)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        store = StoreFactory.create(this)
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0B1020"))
            overScrollMode = View.OVER_SCROLL_NEVER
        }
        setContentView(web)

        // Keep the page clear of the status bar, navigation bar and keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(web) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false      // remote video starts without a tap
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString DuniaApp/${BuildConfig.VERSION_NAME} (${BuildConfig.FLAVOR_NAME})"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) = runOnUiThread { onWebPermission(request) }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                route(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                if (url.startsWith(origin)) offline = false
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && request.url.toString().startsWith(origin)) showOffline()
            }
        }

        installBridge()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (offline) return finish()
                // Let the web app close a dialog / leave a chat first.
                web.evaluateJavascript("(window.__duniaBack ? window.__duniaBack() : false)") { handled ->
                    if (handled != "true") {
                        if (web.canGoBack()) web.goBack() else finish()
                    }
                }
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl(startUrl(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val data = intent.data
        if (data != null && data.host == baseUri.host) web.loadUrl(startUrl(intent)) // invite link while running
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        store.close()
        web.destroy()
        super.onDestroy()
    }

    /** Opens https://<host>/?ref=CODE invite links inside the app. */
    private fun startUrl(intent: Intent?): String {
        val data = intent?.data
        if (data != null && data.scheme == "https" && data.host == baseUri.host) return data.toString()
        return BuildConfig.BASE_URL
    }

    // ------------------------------------------------------------------ navigation
    /** true = handled outside the WebView. */
    private fun route(url: Uri): Boolean {
        val scheme = url.scheme?.lowercase()
        return when {
            scheme == "https" && url.host == baseUri.host -> false
            scheme == "http" && BuildConfig.DEBUG && url.host == baseUri.host -> false
            scheme == "upi" -> { openUpi(url); true }
            scheme == "intent" -> { openIntentUri(url.toString()); true }
            scheme == "file" && url.toString().startsWith("file:///android_asset/") -> false
            else -> { openExternal(url); true }
        }
    }

    /** Any installed UPI app can pay: Google Pay, PhonePe, Paytm, BHIM, bank apps… */
    private fun openUpi(url: Uri) {
        val intent = Intent(Intent.ACTION_VIEW, url)
        try {
            startActivity(Intent.createChooser(intent, getString(R.string.pay_with)))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_upi_app, Toast.LENGTH_LONG).show()
        }
    }

    private fun openIntentUri(uri: String) {
        try {
            val intent = Intent.parseUri(uri, Intent.URI_INTENT_SCHEME).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
                component = null
                selector = null
            }
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(this, R.string.cannot_open, Toast.LENGTH_SHORT).show()
        }
    }

    private fun openExternal(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.cannot_open, Toast.LENGTH_SHORT).show()
        }
    }

    private fun showOffline() {
        offline = true
        web.loadUrl("file:///android_asset/offline.html?u=" + Uri.encode(BuildConfig.BASE_URL))
    }

    // ------------------------------------------------------------------ camera & mic
    private fun onWebPermission(request: PermissionRequest) {
        if (!request.origin.toString().startsWith(origin)) return request.deny()
        val needed = mutableListOf<String>()
        for (r in request.resources) {
            when (r) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> needed += Manifest.permission.CAMERA
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> needed += Manifest.permission.RECORD_AUDIO
            }
        }
        if (needed.isEmpty()) return request.deny()
        val missing = needed.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) return grantAllowed(request, needed.toSet())
        pendingWebPermission?.deny()
        pendingWebPermission = request
        askMedia.launch(missing.toTypedArray())
    }

    private fun grantAllowed(request: PermissionRequest, newlyGranted: Set<String>) {
        val ok = request.resources.filter {
            val perm = when (it) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                else -> return@filter false
            }
            perm in newlyGranted || ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
        }
        if (ok.isEmpty()) request.deny() else request.grant(ok.toTypedArray())
    }

    // ------------------------------------------------------------------ bridge
    /**
     * window.DuniaNative for the Dunia origin only (WebViewCompat.addWebMessageListener):
     * other sites opened in the WebView can never call it.
     */
    private fun installBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(web, "DuniaNative", setOf(origin)) { _, message, _, isMainFrame, reply ->
            if (!isMainFrame) return@addWebMessageListener
            val msg = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (_: Exception) { return@addWebMessageListener }
            handle(msg.optInt("id"), msg.optString("cmd"), msg.optJSONObject("args") ?: JSONObject(), reply)
        }
    }

    private fun handle(id: Int, cmd: String, args: JSONObject, reply: JavaScriptReplyProxy) {
        fun ok(result: Any?) = reply.postMessage(JSONObject().put("id", id).put("ok", true).put("result", result ?: JSONObject.NULL).toString())
        fun fail(code: String) = reply.postMessage(JSONObject().put("id", id).put("ok", false).put("error", code).toString())
        fun <T> send(r: Result<T>) = r.fold({ ok(it) }, { fail((it as? StoreException)?.code ?: "error") })

        when (cmd) {
            "hello" -> ok(JSONObject()
                .put("flavor", BuildConfig.FLAVOR_NAME)
                .put("version", BuildConfig.VERSION_NAME)
                .put("billing", store.billing)
                .put("upiAllowed", store.upiAllowed))
            "products" -> {
                val ids = args.optJSONArray("ids") ?: JSONArray()
                store.products((0 until ids.length()).map { ids.getString(it) }) { send(it) }
            }
            "buy" -> store.buy(this, args.optString("productId"), args.optString("accountId")) { send(it) }
            "consume" -> store.consume(args.optString("purchaseToken")) { send(it) }
            "pending" -> store.pending { send(it) }
            "keepAwake" -> {
                if (args.optBoolean("on")) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                ok(true)
            }
            "share" -> {
                val share = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, args.optString("text"))
                startActivity(Intent.createChooser(share, getString(R.string.share_invite)))
                ok(true)
            }
            "openExternal" -> {
                val uri = Uri.parse(args.optString("url"))
                when (uri.scheme?.lowercase()) {
                    "upi" -> { openUpi(uri); ok(true) }
                    "https" -> { openExternal(uri); ok(true) }
                    else -> fail("scheme")
                }
            }
            else -> fail("unknown_command")
        }
    }
}
