plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

android {
    namespace = "app.autoconfirm"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.autoconfirm"
        minSdk = 26
        targetSdk = 36
        // CI passes -Pautoconfirm.versionCode (must grow with every Play upload).
        versionCode = (project.findProperty("autoconfirm.versionCode") as String?)?.toInt() ?: 6
        versionName = "0.2.0"
        // Privacy policy link shown in the app (Google Play requires one in the app and in the listing).
        buildConfigField("String", "PRIVACY_URL", "\"${project.findProperty("autoconfirm.privacyUrl") ?: ""}\"")
        // Optional certificate pinning for the API host: "host" and comma-separated "sha256/..." pins
        // (primary + backup). Empty = no pinning. Set these in your release build.
        buildConfigField("String", "PIN_HOST", "\"${project.findProperty("autoconfirm.pinHost") ?: ""}\"")
        buildConfigField("String", "PIN_SHA256", "\"${project.findProperty("autoconfirm.pins") ?: ""}\"")
    }

    // Upload key for Google Play (Play re-signs with its own app-signing key). Paths and passwords come from
    // environment variables (CI secrets), never from the repository. Without them, release builds are unsigned.
    val uploadKeystore = System.getenv("AC_UPLOAD_KEYSTORE")?.takeIf { it.isNotBlank() }
    signingConfigs {
        if (uploadKeystore != null) {
            create("upload") {
                storeFile = file(uploadKeystore)
                storePassword = System.getenv("AC_UPLOAD_STORE_PASSWORD")
                keyAlias = System.getenv("AC_UPLOAD_KEY_ALIAS")?.takeIf { it.isNotBlank() } ?: "upload"
                keyPassword = System.getenv("AC_UPLOAD_KEY_PASSWORD")?.takeIf { it.isNotBlank() } ?: System.getenv("AC_UPLOAD_STORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("upload")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.10.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.work:work-runtime-ktx:2.10.5")
    implementation("androidx.room:room-runtime:2.8.3")
    implementation("androidx.room:room-ktx:2.8.3")
    ksp("androidx.room:room-compiler:2.8.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
