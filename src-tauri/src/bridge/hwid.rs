//! Login hardware ids (`mac`, `id0`), derived from the machine the same way on
//! each platform. They aren't random: the login server uses them to identify
//! the device (MFA's "remember this computer" is bound to them), so they need to
//! stay stable across launches. We compute them once, on first use.
//!
//! How they're built (every value is a lowercase 32-char MD5 hex digest):
//!   mac = MD5 of a 6-byte machine id
//!         win:   Win32_ComputerSystemProduct.UUID folded to 6 bytes
//!         mac:   IOPlatformSerialNumber folded to 6 bytes
//!         linux: first NIC MAC address
//!   id0 = MD5 of a platform serial
//!         win:   C: volume serial (4 raw LE bytes)
//!         mac:   IOPlatformSerialNumber string
//!         linux: longest /dev/disk/by-uuid entry
//!   android: both from one seed - a sysfs serial when readable, else a random
//!         id generated once and kept in the app's data directory (see
//!         `android_device_seed`)

use md5::{Digest, Md5};
use once_cell::sync::Lazy;

pub struct HwId {
    pub mac: String,
    pub id0: String,
}

static HWID: Lazy<HwId> = Lazy::new(compute);

pub fn hwid() -> &'static HwId {
    &HWID
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
const ZERO_ID: &str = "00000000000000000000000000000000";

fn hex_md5(bytes: &[u8]) -> String {
    hex_lower(&Md5::new().chain_update(bytes).finalize())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Fold a serial string down into 6 bytes:
/// `byte[k % 6] += ascii[k]` with wrapping, stopping at the first NUL.
#[cfg(any(
    target_os = "windows",
    target_os = "macos",
    not(any(target_os = "windows", target_os = "macos", target_os = "linux")),
    test
))]
fn fold6(s: &[u8]) -> [u8; 6] {
    let mut id = [0u8; 6];
    for (k, &b) in s.iter().enumerate() {
        if b == 0 {
            break;
        }
        id[k % 6] = id[k % 6].wrapping_add(b);
    }
    id
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn nic_mac() -> Option<[u8; 6]> {
    mac_address::get_mac_address().ok().flatten().map(|m| m.bytes())
}

// --- Windows --------------------------------------------------------------

#[cfg(target_os = "windows")]
fn compute() -> HwId {
    let (uuid, os_serial, volume) = windows_ids();
    let unique6 = uuid
        .filter(|u| is_usable_uuid(u))
        .map(|u| fold6(u.as_bytes()))
        .or_else(|| os_serial.filter(|s| !s.is_empty()).map(|s| fold6(s.as_bytes())))
        .or_else(nic_mac);
    HwId {
        mac: unique6.map(|b| hex_md5(&b)).unwrap_or_else(|| ZERO_ID.into()),
        id0: volume.map(|v| hex_md5(&v.to_le_bytes())).unwrap_or_else(|| ZERO_ID.into()),
    }
}

#[cfg(target_os = "windows")]
fn is_usable_uuid(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty()
        && !t.chars().all(|c| c == '0' || c == '-')
        && !t.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
}

/// Pulls (product UUID, OS serial, C: volume serial) from WMI. We prefer the
/// BIOS/product UUID; the OS serial and NIC MAC are the fallbacks.
#[cfg(target_os = "windows")]
fn windows_ids() -> (Option<String>, Option<String>, Option<u32>) {
    use std::collections::HashMap;
    use wmi::{Variant, WMIConnection};

    fn str_field(
        con: &WMIConnection,
        query: &str,
        field: &str,
    ) -> Option<String> {
        let rows: Vec<HashMap<String, Variant>> = con.raw_query(query).ok()?;
        for row in rows {
            if let Some(Variant::String(s)) = row.get(field) {
                if !s.trim().is_empty() {
                    return Some(s.trim().to_string());
                }
            }
        }
        None
    }

    let con = match WMIConnection::new() {
        Ok(c) => c,
        Err(_) => return (None, None, None),
    };

    let uuid = str_field(&con, "SELECT UUID FROM Win32_ComputerSystemProduct", "UUID");
    let os_serial = str_field(&con, "SELECT SerialNumber FROM Win32_OperatingSystem", "SerialNumber");
    let volume = str_field(
        &con,
        "SELECT VolumeSerialNumber FROM Win32_LogicalDisk WHERE DeviceID = 'C:'",
        "VolumeSerialNumber",
    )
    .and_then(|s| u32::from_str_radix(s.trim(), 16).ok());

    (uuid, os_serial, volume)
}

// --- macOS ----------------------------------------------------------------

#[cfg(target_os = "macos")]
fn compute() -> HwId {
    match macos_serial() {
        Some(s) if !s.is_empty() => HwId {
            mac: hex_md5(&fold6(s.as_bytes())),
            id0: hex_md5(s.as_bytes()),
        },
        _ => HwId {
            mac: nic_mac().map(|b| hex_md5(&b)).unwrap_or_else(|| ZERO_ID.into()),
            id0: ZERO_ID.into(),
        },
    }
}

/// The IOPlatformSerialNumber, read from IOKit.
#[cfg(target_os = "macos")]
fn macos_serial() -> Option<String> {
    let out = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if line.contains("IOPlatformSerialNumber") {
            if let Some(eq) = line.find('=') {
                let v = line[eq + 1..].trim().trim_matches('"').trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

// --- Linux ----------------------------------------------------------------

#[cfg(target_os = "linux")]
fn compute() -> HwId {
    HwId {
        mac: nic_mac().map(|b| hex_md5(&b)).unwrap_or_else(|| ZERO_ID.into()),
        id0: linux_disk_uuid().map(|u| hex_md5(u.as_bytes())).unwrap_or_else(|| ZERO_ID.into()),
    }
}

/// The longest entry in /dev/disk/by-uuid (ties go to the alphabetically last one).
#[cfg(target_os = "linux")]
fn linux_disk_uuid() -> Option<String> {
    let mut best = String::new();
    for entry in std::fs::read_dir("/dev/disk/by-uuid").ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.len() > best.len() || (name.len() == best.len() && name > best) {
            best = name;
        }
    }
    (!best.is_empty()).then_some(best)
}

// --- Android --------------------------------------------------------------

#[cfg(target_os = "android")]
fn compute() -> HwId {
    let seed = android_device_seed();
    HwId {
        mac: hex_md5(&fold6(seed.as_bytes())),
        id0: hex_md5(seed.as_bytes()),
    }
}

/// A device seed that stays put across launches and reboots. login.rs sends
/// `mac`/`id0` derived from it, and the login server binds the MFA "remember
/// this device" record to them - a seed that drifts means an MFA code at every
/// login, and a fixed literal shared by all installs is what the login server
/// would treat as one device. Order: a readable sysfs serial (rare on current
/// Android, but truly per-device), else a random id generated once and kept in
/// the app's data directory. The kernel boot_id that used to follow (new every
/// boot) is exactly the drift this avoids. No subprocess - some builds abort on
/// `getprop`.
#[cfg(target_os = "android")]
fn android_device_seed() -> String {
    for path in [
        "/sys/devices/soc0/serial_number",
        "/sys/devices/virtual/dmi/id/product_uuid",
    ] {
        if let Ok(s) = std::fs::read_to_string(path) {
            let t = s.trim().to_string();
            if !t.is_empty() && !t.eq_ignore_ascii_case("unknown") {
                return t;
            }
        }
    }
    if let Some(id) = android_data_dir().and_then(|dir| persisted_device_id(&dir)) {
        return id;
    }
    // Neither a serial nor a writable data directory: a fixed value at least
    // does not change between launches.
    "minibee-android".into()
}

/// The app's private data directory - the one Tauri's `app_data_dir` resolves
/// to on Android (`Context.dataDir`, i.e. `/data/user/<user>/<package>`, where
/// settings.json lives). No AppHandle reaches this module (login.rs calls
/// `hwid()` bare), so it comes from the process itself: MainActivity exports
/// the exact path as MINIBEE_DATA_DIR before the native library loads, and
/// failing that the same layout is rebuilt from `/proc/self/cmdline` (the
/// process name is the package name; no `android:process` is set) and the
/// Android user number, which is the uid divided by 100000.
#[cfg(target_os = "android")]
fn android_data_dir() -> Option<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("MINIBEE_DATA_DIR") {
        let p = std::path::PathBuf::from(dir);
        if p.is_dir() {
            return Some(p);
        }
    }
    let cmdline = std::fs::read("/proc/self/cmdline").ok()?;
    let package = cmdline
        .split(|&b| b == 0)
        .next()
        .map(|s| String::from_utf8_lossy(s).trim().to_string())
        .filter(|s| !s.is_empty() && !s.contains('/'))?;
    let uid = {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata("/proc/self").ok()?.uid()
    };
    let p = std::path::PathBuf::from(format!("/data/user/{}/{}", uid / 100_000, package));
    p.is_dir().then_some(p)
}

/// The random id kept in `<dir>/device-id`: read back when present and
/// well-formed (32 lowercase hex chars), otherwise 16 bytes from the OS random
/// source, stored as hex. `None` when the directory cannot be written - the
/// caller then falls back rather than keep a value that would not survive the
/// next launch.
#[cfg(any(target_os = "android", test))]
fn persisted_device_id(dir: &std::path::Path) -> Option<String> {
    let path = dir.join("device-id");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let t = s.trim();
        if t.len() == 32 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Some(t.to_ascii_lowercase());
        }
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    let id = hex_lower(&bytes);
    std::fs::write(&path, &id).ok()?;
    Some(id)
}

// --- Other (non-desktop) --------------------------------------------------

#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "linux",
    target_os = "android"
)))]
fn compute() -> HwId {
    let seed = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "minibee-device".into());
    HwId {
        mac: hex_md5(&fold6(seed.as_bytes())),
        id0: hex_md5(seed.as_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_matches_ll_algorithm() {
        // "ABCDEFG" wraps around: byte0 = 'A'+'G', bytes1..5 = 'B'..'F'.
        let f = fold6(b"ABCDEFG");
        assert_eq!(f[0], b'A'.wrapping_add(b'G'));
        assert_eq!(f[1], b'B');
        assert_eq!(f[5], b'F');
    }

    #[test]
    fn fold_stops_at_nul() {
        assert_eq!(fold6(b"AB\0CD"), fold6(b"AB"));
    }

    #[test]
    fn md5_is_lowercase_hex_32() {
        let h = hex_md5(b"");
        assert_eq!(h, "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(h.len(), 32);
    }

    #[test]
    fn hex_md5_matches_write_macro_reference() {
        fn reference(bytes: &[u8]) -> String {
            use std::fmt::Write;
            let digest = Md5::new().chain_update(bytes).finalize();
            let mut out = String::with_capacity(32);
            for b in digest {
                let _ = write!(out, "{b:02x}");
            }
            out
        }
        for input in [
            &b""[..],
            b"abc",
            b"hello",
            &[0u8, 0xff, 1, 2, 3, 4],
            b"fold6 test vector",
        ] {
            assert_eq!(hex_md5(input), reference(input), "input {:?}", input);
        }
    }

    #[test]
    fn persisted_device_id_is_created_once_and_read_back() {
        let dir = std::env::temp_dir().join(format!(
            "minibee-hwid-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let first = persisted_device_id(&dir).expect("id in a writable dir");
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        // The second call must read the stored id, not draw a new one.
        assert_eq!(persisted_device_id(&dir).as_deref(), Some(first.as_str()));
        assert_eq!(std::fs::read_to_string(dir.join("device-id")).unwrap(), first);

        // A damaged file is replaced instead of being trusted.
        std::fs::write(dir.join("device-id"), "not hex").unwrap();
        let replaced = persisted_device_id(&dir).unwrap();
        assert_ne!(replaced, first);
        assert_eq!(replaced.len(), 32);

        // An unwritable location yields None rather than a one-off value.
        assert!(persisted_device_id(&dir.join("missing").join("deeper")).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hwid_is_stable_and_nonempty() {
        let a = hwid();
        let b = hwid();
        assert_eq!(a.mac, b.mac);
        assert_eq!(a.id0, b.id0);
        assert_eq!(a.mac.len(), 32);
        assert_eq!(a.id0.len(), 32);
    }
}
