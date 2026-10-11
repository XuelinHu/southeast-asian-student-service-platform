plugins {
    id("com.android.application")
}

android {
    namespace = "com.xuelinhu.lanwebclient"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.xuelinhu.studentservices"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "DEFAULT_URL", "\"http://192.168.1.9:4034\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = false
        }
    }
}
