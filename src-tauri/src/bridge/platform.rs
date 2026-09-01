//! Real platform strings for the `login_to_simulator` XML body (no spoofing).

pub struct LoginPlatform {
    pub platform: &'static str,
    pub platform_version: String,
    pub platform_string: String,
}

/// Values sent as `platform`, `platform_version`, and `platform_string` at login.
pub fn login_platform() -> LoginPlatform {
    let osi = os_info::get();
    let ver = normalize_version(osi.version().to_string());

    match osi.os_type() {
        os_info::Type::Windows => {
            let platform_version = windows_login_version(&ver);
            LoginPlatform {
                platform: "Win",
                platform_string: format!("Microsoft Windows NT {platform_version}"),
                platform_version,
            }
        }
        os_info::Type::Macos => LoginPlatform {
            platform: "Mac",
            platform_version: ver.clone(),
            platform_string: if ver.is_empty() {
                "Mac OS X".into()
            } else {
                format!("Mac OS X {ver}")
            },
        },
        os_info::Type::Linux => LoginPlatform {
            platform: "Lin",
            platform_version: ver.clone(),
            platform_string: if ver.is_empty() {
                "Linux".into()
            } else {
                format!("Linux {ver}")
            },
        },
        os_info::Type::Android => LoginPlatform {
            platform: "Android",
            platform_version: ver.clone(),
            platform_string: if ver.is_empty() {
                "Android".into()
            } else {
                format!("Android {ver}")
            },
        },
        os_info::Type::Ios => LoginPlatform {
            platform: "iOS",
            platform_version: ver.clone(),
            platform_string: if ver.is_empty() {
                "iOS".into()
            } else {
                format!("iOS {ver}")
            },
        },
        _ => LoginPlatform {
            platform: std::env::consts::OS,
            platform_version: ver.clone(),
            platform_string: format!("{} {}", std::env::consts::OS, ver),
        },
    }
}

/// True for the Google Play edition: the Android AAB built with
/// MINIBEE_PLAY_BUILD=1 (`npm run build:android:play`). Play policy puts
/// virtual-currency purchases under the store's own billing and publishes a
/// monetized developer's legal address, so that edition compiles without the
/// Buy L$ flow. Sideload APKs and desktop builds keep it.
pub fn play_store_build() -> bool {
    cfg!(target_os = "android") && option_env!("MINIBEE_PLAY_BUILD").is_some_and(|v| v == "1")
}

pub fn login_address_size() -> u64 {
    if cfg!(target_pointer_width = "64") {
        64
    } else {
        32
    }
}

fn normalize_version(ver: String) -> String {
    let t = ver.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("unknown") {
        "0.0.0".to_string()
    } else {
        t.to_string()
    }
}

/// Linden login historically uses a short `major.minor` on Windows (e.g. `10.0`).
fn windows_login_version(ver: &str) -> String {
    let parts: Vec<&str> = ver
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .collect();
    match parts.len() {
        0 => "10.0".into(),
        1 => format!("{}.0", parts[0]),
        _ => format!("{}.{}", parts[0], parts[1]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_login_version_shortens() {
        assert_eq!(windows_login_version("10.0.26200"), "10.0");
        assert_eq!(windows_login_version("11"), "11.0");
    }

    #[test]
    fn login_platform_is_populated() {
        let p = login_platform();
        assert!(!p.platform.is_empty());
        assert!(!p.platform_version.is_empty());
        assert!(!p.platform_string.is_empty());
    }

    #[test]
    fn play_store_flag_is_android_only() {
        // Whatever the build environment says, a non-Android target is never
        // the Play edition.
        if !cfg!(target_os = "android") {
            assert!(!play_store_build());
        }
    }

    #[test]
    fn address_size_matches_pointer_width() {
        let size = login_address_size();
        assert!(size == 32 || size == 64);
    }
}
