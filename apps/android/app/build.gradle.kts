plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.synara.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.synara.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "0.2.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    val releaseStore = providers.environmentVariable("SYNARA_ANDROID_KEYSTORE")
    if (releaseStore.isPresent) {
        signingConfigs.create("release") {
            storeFile = file(releaseStore.get())
            storePassword = providers.environmentVariable("SYNARA_ANDROID_STORE_PASSWORD").get()
            keyAlias = providers.environmentVariable("SYNARA_ANDROID_KEY_ALIAS").get()
            keyPassword = providers.environmentVariable("SYNARA_ANDROID_KEY_PASSWORD").get()
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseStore.isPresent) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    buildFeatures { buildConfig = true }
    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) } }

dependencies {
    implementation(project(":capacitor-android"))
    implementation(project(":capacitor-cordova-android-plugins"))
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.test.espresso:espresso-web:3.7.0")
}
apply(from = "capacitor.build.gradle")

// A native-only Android Studio build must fail rather than ship a blank shell.
tasks.named("preBuild") {
    doFirst {
        check(file("src/main/assets/public/index.html").isFile) {
            "Shared UI missing. Run bun run --cwd apps/android prepare:android from the repository root."
        }
    }
}
