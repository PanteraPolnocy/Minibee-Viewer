//! Login hardware ids (`mac`, `id0`), derived from the machine so they line up
//! with what the reference viewer computes in `llmachineid` / `generateSerialNumber`
//! on each platform. They aren't random: the login server uses them to identify
//! the device (MFA's "remember this computer" is bound to them), so they need to
//! stay stable across launches. We compute them once, on first use.
//!
//! How the reference viewer builds them (every value is a lowercase 32-char MD5 hex digest):
//!   mac = MD5 of a 6-byte machine id
//!         win:   Win32_ComputerSystemProduct.UUID folded to 6 bytes
//!         mac:   IOPlatformSerialNumber folded to 6 bytes
//!         linux: first NIC MAC address
//!   id0 = MD5 of a platform serial
//!         win:   C: volume serial (4 raw LE bytes)
//!         mac:   IOPlatformSerialNumber string
//!         linux: longest /dev/disk/by-uuid entry

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

const ZERO_ID: &str = "00000000000000000000000000000000";

fn hex_md5(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let digest = Md5::new().chain_update(bytes).finalize();
    let mut out = String::with_capacity(32);
    for b in digest {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Fold a serial string down into 6 bytes exactly as `llmachineid.cpp` does:
/// `byte[k % 6] += ascii[k]` with wrapping, stopping at the first NUL.
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
/// BIOS/product UUID since that's what FS uses; the OS serial and NIC MAC are the fallbacks.
#[cfg(target_os = "windows")]
fn windows_ids() -> (Option<String>, Option<String>, Option<u32>) {
    use std::collections::HashMap;
    use wmi::{COMLibrary, Variant, WMIConnection};

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

    let com = match COMLibrary::new() {
        Ok(c) => c,
        Err(_) => return (None, None, None),
    };
    let con = match WMIConnection::new(com) {
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

/// The IOPlatformSerialNumber, the same value FS reads from IOKit.
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

/// The longest entry in /dev/disk/by-uuid (ties go to the alphabetically last one), matching FS.
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

// --- Mobile / other -------------------------------------------------------

// The reference viewer has no mobile counterpart, so there's nothing to mirror here yet.
// TODO(mobile): route Android Settings.Secure.ANDROID_ID / iOS
// identifierForVendor through a platform plugin. Until that's in place, we derive a stable id
// from the hostname so a device keeps the same id across launches.
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
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
    fn hwid_is_stable_and_nonempty() {
        let a = hwid();
        let b = hwid();
        assert_eq!(a.mac, b.mac);
        assert_eq!(a.id0, b.id0);
        assert_eq!(a.mac.len(), 32);
        assert_eq!(a.id0.len(), 32);
    }
}
