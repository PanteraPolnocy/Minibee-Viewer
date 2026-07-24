use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // Build metadata surfaced on the Settings → About screen. Emitted as
    // compile-time env vars (read with env!); cross-platform, no extra crates.
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=MINIBEE_BUILD_EPOCH={epoch}");

    let rustc = Command::new(std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into()))
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=MINIBEE_RUSTC={rustc}");

    for (key, var) in [
        ("MINIBEE_TARGET", "TARGET"),
        ("MINIBEE_HOST", "HOST"),
        ("MINIBEE_PROFILE", "PROFILE"),
        ("MINIBEE_OPT_LEVEL", "OPT_LEVEL"),
    ] {
        println!(
            "cargo:rustc-env={key}={}",
            std::env::var(var).unwrap_or_default()
        );
    }

    tauri_build::build()
}
