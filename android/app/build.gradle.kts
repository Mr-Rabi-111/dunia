import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val baseUrl = (findProperty("duniaBaseUrl") as String? ?: "https://dunia.example.com").trimEnd('/')
val appId = findProperty("duniaAppId") as String? ?: "app.dunia.chat"
val host: String = URI(baseUrl).host ?: "dunia.example.com"

android {
    namespace = "app.dunia.chat"
    compileSdk = 36

    defaultConfig {
        applicationId = appId
        minSdk = 24            // Android 7.0+: WebRTC in the system WebView
        targetSdk = 36         // Google Play: new apps & updates must target API 36 from 31 Aug 2026
        versionCode = (findProperty("duniaVersionCode") as String? ?: "1").toInt()
        versionName = findProperty("duniaVersionName") as String? ?: "1.0.0"
        buildConfigField("String", "BASE_URL", "\"$baseUrl\"")
        manifestPlaceholders["duniaHost"] = host
    }

    // Release signing comes from environment variables (CI secrets); never commit a keystore.
    signingConfigs {
        create("release") {
            val ks = System.getenv("DUNIA_KEYSTORE_FILE")
            if (!ks.isNullOrBlank() && file(ks).exists()) {
                storeFile = file(ks)
                storePassword = System.getenv("DUNIA_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DUNIA_KEY_ALIAS")
                keyPassword = System.getenv("DUNIA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val release = signingConfigs.getByName("release")
            signingConfig = if (release.storeFile != null) release else signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    flavorDimensions += "store"
    productFlavors {
        // Google Play Store build: all purchases go through Google Play Billing.
        create("play") {
            dimension = "store"
            buildConfigField("String", "FLAVOR_NAME", "\"play\"")
        }
        // Direct download (your website / other stores): UPI checkout, no Play Billing.
        create("direct") {
            dimension = "store"
            applicationIdSuffix = ".direct"
            buildConfigField("String", "FLAVOR_NAME", "\"direct\"")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = true
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    "playImplementation"("com.android.billingclient:billing:8.0.0")
}
