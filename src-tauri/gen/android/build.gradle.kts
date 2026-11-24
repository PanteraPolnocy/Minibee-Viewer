buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        // Kept the same as in buildSrc/build.gradle.kts: the version named
        // there is the one the build really loads.
        classpath("com.android.tools.build:gradle:8.13.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.21")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

