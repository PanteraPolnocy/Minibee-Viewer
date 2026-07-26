plugins {
    `kotlin-dsl`
}

gradlePlugin {
    plugins {
        create("rust") {
            id = "rust"
            implementationClass = "com.pantera.minibee_viewer.kotlin.RustPlugin"
        }
    }
}

repositories {
    google()
    mavenCentral()
}

dependencies {
    compileOnly(gradleApi())
    implementation("com.android.tools.build:gradle:9.3.1")
}

