# Dunia for Android — build the APK

The Android app lives in [`android/`](../android). It's a small native Kotlin app that runs the Dunia
web app in a WebView and adds what a browser can't do well: Android camera/mic permissions, Google Play
Billing, opening UPI apps, the share sheet, the back button, keeping the screen on during calls,
invite links that open the app, and an offline screen.

Because the interface is the website, **every web improvement reaches the app instantly** without
a store update.

## What you need first

- Your Dunia server running on **HTTPS** with a domain (see [DEPLOYMENT.md](DEPLOYMENT.md)). The app
  opens that address.
- One of:
  - a **GitHub account** (easiest: the APK is built for you, nothing to install), or
  - **Android Studio** (Ladybug or newer) on your computer.

## Option A — build on GitHub (no installs)

1. Put this project in a GitHub repository (public or private).
2. Settings → Secrets and variables → Actions → **Variables** → New variable:
   `DUNIA_BASE_URL` = `https://your-domain` (no trailing slash).
3. Actions → **Android** → **Run workflow**.
4. After about 5 minutes, open the run → **Artifacts**:
   - `dunia-direct-apk` → **`app-direct-release.apk`**: install on any Android phone and share from your website. Payments: UPI.
   - `dunia-play-aab` → **`app-play-release.aab`**: upload this to Google Play. Payments: Google Play Billing.
   - `dunia-play-apk`: the Play build as an APK, for testing.

Without signing secrets the release builds are signed with a debug key: fine for testing and
sideloading, **not accepted by Google Play**. To sign properly:

```bash
# once, on your computer (keep this file and passwords safe forever)
keytool -genkeypair -v -keystore dunia-upload.jks -alias dunia -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 dunia-upload.jks > dunia-upload.b64      # macOS: base64 -i dunia-upload.jks
```

Add these **Secrets**: `DUNIA_KEYSTORE_BASE64` (contents of the .b64 file), `DUNIA_KEYSTORE_PASSWORD`,
`DUNIA_KEY_ALIAS` (`dunia`), `DUNIA_KEY_PASSWORD`. Run the workflow again.

## Option B — Android Studio

1. File → Open → select the `android` folder. Let Gradle sync.
2. Open `android/gradle.properties` and set `duniaBaseUrl=https://your-domain`.
3. Build variants panel: choose `directDebug` (UPI) or `playDebug` (Play Billing).
4. Run ▶ on a phone with USB debugging, or Build → Generate Signed App Bundle / APK for release.

Command line (JDK 17 and Android SDK installed):

```bash
cd android
./gradlew assembleDirectRelease          # → app/build/outputs/apk/direct/release/
./gradlew bundlePlayRelease              # → app/build/outputs/bundle/playRelease/
./gradlew assembleDirectDebug -PduniaBaseUrl=http://10.0.2.2:3000   # emulator → local dev server
```

Debug builds allow plain `http://` so you can point them at a dev server; release builds are HTTPS-only.

## Settings (`android/gradle.properties` or `-P` flags)

| Property | Default | Meaning |
|---|---|---|
| `duniaBaseUrl` | `https://dunia.example.com` | Your Dunia server |
| `duniaAppId` | `app.dunia.chat` | Package name (Play build). The direct build adds `.direct` |
| `duniaVersionCode` | `1` | Must increase with every Play upload (CI uses the run number) |
| `duniaVersionName` | `1.0.0` | Version shown to users |

## How the app and the website talk

The app injects `window.DuniaNative` **only into pages from your own domain**
(`WebViewCompat.addWebMessageListener` with an origin allow-list), so no other website can call it.
Messages are JSON: `{ id, cmd, args }` → `{ id, ok, result | error }`.

| Command | Does |
|---|---|
| `hello` | `{ flavor, version, billing, upiAllowed }`, so the website knows it's in the app |
| `products` | Localised Play prices for the pass product IDs |
| `buy` | Opens the Google Play purchase sheet (with the device's `obfuscatedAccountId`) |
| `consume` | Consumes a pass after the server has granted the time |
| `pending` | Purchases that were paid but not yet delivered (e.g. the app was closed) |
| `keepAwake` | Keeps the screen on during chats |
| `share` | Android share sheet (invite link → WhatsApp etc.) |
| `openExternal` | Opens a `upi://` payment in the user's UPI app (chooser: GPay, PhonePe, Paytm, BHIM…) or a web link |

Web side: [`public/js/android.js`](../public/js/android.js) and [`public/js/premium.js`](../public/js/premium.js).
Native side: [`MainActivity.kt`](../android/app/src/main/java/app/dunia/chat/MainActivity.kt),
[`play/…/StoreFactory.kt`](../android/app/src/play/java/app/dunia/chat/StoreFactory.kt) (Billing Library 8),
[`direct/…/StoreFactory.kt`](../android/app/src/direct/java/app/dunia/chat/StoreFactory.kt).

## Invite links open the app

`https://your-domain/?ref=CODE` opens Dunia directly when the app is installed (Android App Links).
Set `ANDROID_CERT_SHA256` on the server to your signing certificate's SHA-256 (Play Console → App
integrity → App signing key certificate; for the direct APK, `keytool -list -v -keystore dunia-upload.jks`).
The server then publishes `/.well-known/assetlinks.json`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Black screen / "You're offline" | `duniaBaseUrl` wrong, or the server isn't on HTTPS with a valid certificate |
| Camera doesn't start | Allow Camera and Microphone in Android Settings → Apps → Dunia → Permissions |
| "No UPI app found" | Install any UPI app, or scan the QR from another phone |
| Google Pay says the payment was declined | Some apps block link-started payments to personal UPI IDs. Scan the QR instead, or use a merchant UPI ID ([MONETIZATION.md](MONETIZATION.md) §8) |
| Play prices don't show | Products must be *active* in Play Console and the app installed from a Play testing track |
| Build fails with "SDK location not found" | Open once in Android Studio, or create `android/local.properties` with `sdk.dir=/path/to/Android/sdk` |
