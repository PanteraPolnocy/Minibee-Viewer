//! Sealing the MFA "remember this device" hash for storage on disk.
//!
//! After a successful authenticator check the grid hands back an `mfa_hash`;
//! presenting it on later logins skips the code prompt. It never sits on disk
//! in the clear: the record is sealed under the account password and opened
//! with the password typed at login. Being authenticated, it opens to nothing
//! under any other password, so a typo sends no hash at all and the grid's own
//! password check decides the outcome.
//!
//! Construction (encrypt-then-MAC from SHA-256 alone, so no extra crates):
//! PBKDF2-HMAC-SHA256 over the password and a fresh salt derives an encryption
//! key and a MAC key; the hash is XORed with an HMAC counter-mode keystream;
//! an HMAC tag over version, salt and ciphertext authenticates the record. A
//! wrong password, a stale format, or a tampered record fails the tag check
//! and opens to nothing - the caller then just asks for a code again.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use sha2::{Digest, Sha256};

const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const TAG_LEN: usize = 32;
const KEY_LEN: usize = 32;
/// PBKDF2 rounds. The record is worthless without the password, so this only
/// has to make offline password guessing against the tag expensive.
const ITERATIONS: u32 = 200_000;
/// An mfa_hash is a short token; anything past this is not one of our records.
const MAX_SEALED_LEN: usize = 4096;

/// HMAC-SHA256 with the padded-key states prepared once, so the PBKDF2 loop
/// costs two compressions per round instead of re-padding the key each time.
struct HmacSha256 {
    inner: Sha256,
    outer: Sha256,
}

impl HmacSha256 {
    fn new(key: &[u8]) -> Self {
        let mut block = [0u8; 64];
        if key.len() > block.len() {
            block[..KEY_LEN].copy_from_slice(&Sha256::digest(key));
        } else {
            block[..key.len()].copy_from_slice(key);
        }
        let mut inner = Sha256::new();
        let mut outer = Sha256::new();
        inner.update(block.map(|b| b ^ 0x36));
        outer.update(block.map(|b| b ^ 0x5c));
        HmacSha256 { inner, outer }
    }

    fn mac(&self, parts: &[&[u8]]) -> [u8; 32] {
        let mut inner = self.inner.clone();
        for part in parts {
            inner.update(part);
        }
        let mut outer = self.outer.clone();
        outer.update(inner.finalize());
        outer.finalize().into()
    }
}

/// PBKDF2 (RFC 8018) with HMAC-SHA256 as the PRF, filling `out` in full.
fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32, out: &mut [u8]) {
    let prf = HmacSha256::new(password);
    for (index, chunk) in out.chunks_mut(32).enumerate() {
        let block_number = (index as u32 + 1).to_be_bytes();
        let mut u = prf.mac(&[salt, &block_number]);
        let mut acc = u;
        for _ in 1..iterations {
            u = prf.mac(&[&u]);
            for (a, b) in acc.iter_mut().zip(u.iter()) {
                *a ^= b;
            }
        }
        chunk.copy_from_slice(&acc[..chunk.len()]);
    }
}

/// Encryption and MAC keys for one record: one PBKDF2 block of master key
/// (a second block would double the cost), expanded into the two subkeys.
fn derive_keys(password: &str, salt: &[u8]) -> (HmacSha256, HmacSha256) {
    let mut master = [0u8; KEY_LEN];
    pbkdf2_sha256(password.as_bytes(), salt, ITERATIONS, &mut master);
    let expand = HmacSha256::new(&master);
    let keys = (
        HmacSha256::new(&expand.mac(&[b"minibee-mfa-enc"])),
        HmacSha256::new(&expand.mac(&[b"minibee-mfa-mac"])),
    );
    master.fill(0);
    keys
}

/// XOR `data` with the HMAC counter-mode keystream, in place. Every record has
/// its own salt and therefore its own key, so the counter alone keeps blocks
/// distinct; the salt is mixed in as well so nothing depends on that argument.
fn apply_keystream(enc: &HmacSha256, salt: &[u8], data: &mut [u8]) {
    for (counter, chunk) in data.chunks_mut(32).enumerate() {
        let block = enc.mac(&[salt, &(counter as u32).to_be_bytes()]);
        for (d, k) in chunk.iter_mut().zip(block.iter()) {
            *d ^= k;
        }
    }
}

fn tag_for(mac: &HmacSha256, salt: &[u8], ciphertext: &[u8]) -> [u8; TAG_LEN] {
    mac.mac(&[&[VERSION], salt, ciphertext])
}

/// Constant-time equality, so a tag check leaks nothing through timing.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A salt unique to this record. std's RandomState draws its keys from the OS
/// RNG and steps them per instance; several draws hashed together with the
/// clock and pid make repeats vanishingly unlikely, which is all a KDF salt
/// has to guarantee.
fn fresh_salt() -> [u8; SALT_LEN] {
    let mut h = Sha256::new();
    for _ in 0..4 {
        h.update(RandomState::new().build_hasher().finish().to_ne_bytes());
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    h.update(nanos.to_ne_bytes());
    h.update(std::process::id().to_ne_bytes());
    let digest = h.finalize();
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&digest[..SALT_LEN]);
    salt
}

/// Seal `hash` under `password`. Empty inputs have nothing to protect and
/// yield `None`.
pub fn seal(password: &str, hash: &str) -> Option<String> {
    if password.is_empty() || hash.is_empty() {
        return None;
    }
    let salt = fresh_salt();
    let (enc, mac) = derive_keys(password, &salt);
    let mut body = hash.as_bytes().to_vec();
    apply_keystream(&enc, &salt, &mut body);
    let tag = tag_for(&mac, &salt, &body);
    let mut record = Vec::with_capacity(1 + SALT_LEN + TAG_LEN + body.len());
    record.push(VERSION);
    record.extend_from_slice(&salt);
    record.extend_from_slice(&tag);
    record.extend_from_slice(&body);
    Some(B64.encode(record))
}

/// Recover the hash from a record sealed by [`seal`]. `None` for a wrong
/// password, a record in another format (the old plaintext store included),
/// or anything tampered with.
pub fn open(password: &str, sealed: &str) -> Option<String> {
    let sealed = sealed.trim();
    if password.is_empty() || sealed.is_empty() || sealed.len() > MAX_SEALED_LEN {
        return None;
    }
    let record = B64.decode(sealed).ok()?;
    if record.len() <= 1 + SALT_LEN + TAG_LEN || record[0] != VERSION {
        return None;
    }
    let salt = &record[1..1 + SALT_LEN];
    let tag = &record[1 + SALT_LEN..1 + SALT_LEN + TAG_LEN];
    let mut body = record[1 + SALT_LEN + TAG_LEN..].to_vec();
    let (enc, mac) = derive_keys(password, salt);
    if !ct_eq(&tag_for(&mac, salt, &body), tag) {
        return None;
    }
    apply_keystream(&enc, salt, &mut body);
    String::from_utf8(body).ok().filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 2: key "Jefe", data "what do ya want for nothing?".
        let mac = HmacSha256::new(b"Jefe").mac(&[b"what do ya want for nothing?"]);
        assert_eq!(hex(&mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // Test case 6: a key longer than the block size is hashed first.
        let long_key = [0xaau8; 131];
        let mac = HmacSha256::new(&long_key).mac(&[b"Test Using Larger Than Block-Size Key - Hash Key First"]);
        assert_eq!(hex(&mac), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
        // Splitting the message across parts must not change the result.
        let a = HmacSha256::new(b"k").mac(&[b"hello ", b"world"]);
        let b = HmacSha256::new(b"k").mac(&[b"hello world"]);
        assert_eq!(a, b);
    }

    #[test]
    fn pbkdf2_matches_rfc_7914_vectors() {
        // P = "passwd", S = "salt", c = 1, dkLen = 64.
        let mut out = [0u8; 64];
        pbkdf2_sha256(b"passwd", b"salt", 1, &mut out);
        assert_eq!(
            hex(&out),
            "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc\
             49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783"
        );
        // P = "Password", S = "NaCl", c = 80000, dkLen = 64.
        pbkdf2_sha256(b"Password", b"NaCl", 80000, &mut out);
        assert_eq!(
            hex(&out),
            "4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56\
             a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d"
        );
    }

    #[test]
    fn seal_roundtrips_and_hides_the_hash() {
        let hash = "F7lS2yDj9kz0Q3mA1bC4dE5fG6hH7iJ8";
        let sealed = seal("correct horse", hash).expect("sealed");
        assert!(!sealed.contains(hash), "the hash must not appear in the record");
        assert_eq!(open("correct horse", &sealed).as_deref(), Some(hash));
        // Every seal gets its own salt, so the same input never repeats on disk.
        assert_ne!(seal("correct horse", hash).unwrap(), sealed);
    }

    #[test]
    fn open_rejects_wrong_password_and_damage() {
        let sealed = seal("right", "the-hash").unwrap();
        assert_eq!(open("wrong", &sealed), None);
        assert_eq!(open("", &sealed), None);
        assert_eq!(open("right", ""), None);
        // Flip one ciphertext bit: the tag no longer matches.
        let mut record = B64.decode(&sealed).unwrap();
        let last = record.len() - 1;
        record[last] ^= 0x01;
        assert_eq!(open("right", &B64.encode(&record)), None);
        // A record from another version is not ours.
        let mut record = B64.decode(&sealed).unwrap();
        record[0] = VERSION + 1;
        assert_eq!(open("right", &B64.encode(&record)), None);
        // The old store kept the hash in the clear; that is not a record either.
        assert_eq!(open("right", "the-hash"), None);
        assert_eq!(open("right", "bm90IGEgcmVjb3Jk"), None);
        assert_eq!(open("right", &"A".repeat(MAX_SEALED_LEN + 4)), None);
    }

    #[test]
    fn seal_needs_something_to_protect() {
        assert_eq!(seal("", "hash"), None);
        assert_eq!(seal("pw", ""), None);
    }

    #[test]
    fn unicode_passwords_and_long_hashes_survive() {
        let hash = "x".repeat(300);
        let sealed = seal("pässwörd 密码", &hash).unwrap();
        assert_eq!(open("pässwörd 密码", &sealed).as_deref(), Some(hash.as_str()));
        assert_eq!(open("pässwörd 密碼", &sealed), None);
    }
}
