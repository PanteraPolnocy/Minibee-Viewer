//! Build `reqwest` HTTP clients.
//!
//! Desktop uses the OS trust store via `rustls-platform-verifier` (default reqwest builder).
//! Android cannot use that without JVM setup, so we pin Mozilla roots with
//! `tls_certs_only` instead (see tombstone: "Expect rustls-platform-verifier to be initialized").

#[cfg(target_os = "android")]
use once_cell::sync::Lazy;

#[cfg(target_os = "android")]
static ANDROID_ROOTS: Lazy<Vec<reqwest::Certificate>> = Lazy::new(|| {
    webpki_root_certs::TLS_SERVER_ROOT_CERTS
        .iter()
        .map(|der| {
            reqwest::Certificate::from_der(der.as_ref())
                .expect("mozilla root cert DER is valid")
        })
        .collect()
});

/// Shared `reqwest` builder for outbound HTTPS (login, caps proxy, map tiles, feeds).
pub fn builder() -> reqwest::ClientBuilder {
    #[cfg(target_os = "android")]
    {
        return reqwest::Client::builder()
            .tls_backend_rustls()
            .tls_certs_only(ANDROID_ROOTS.iter().cloned());
    }
    #[cfg(not(target_os = "android"))]
    {
        reqwest::Client::builder()
    }
}
