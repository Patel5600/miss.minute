plugins {
    id("com.android.application")
}

android {
    namespace = "com.patel5600.missminute.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.patel5600.missminute.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
}

dependencies {
    // SQLCipher 4.20.0 encrypts the full SQLite database file. The database
    // key is wrapped by a non-exportable Android Keystore AES-GCM key.
    implementation("net.zetetic:sqlcipher-android:4.20.0")
    implementation("androidx.sqlite:sqlite:2.7.0")
}
