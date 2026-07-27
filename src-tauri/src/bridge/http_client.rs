//! Build `reqwest` HTTP clients.
//!
//! Desktop uses the OS trust store via `rustls-platform-verifier` (pulled in by reqwest).
//! Android cannot use that without JVM setup, so we pin Mozilla roots with
//! `use_preconfigured_tls` instead (see tombstone: "Expect rustls-platform-verifier to be initialized").

#[cfg(target_os = "android")]
fn android_tls() -> std::sync::Arc<rustls::ClientConfig> {
    use rustls::crypto::aws_lc_rs;
    use rustls::ClientConfig;

    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    std::sync::Arc::new(
        ClientConfig::builder_with_provider(std::sync::Arc::new(aws_lc_rs::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("tls protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

/// Shared `reqwest` builder for outbound HTTPS (login, caps proxy, map tiles, feeds).
pub fn builder() -> reqwest::ClientBuilder {
    #[cfg(target_os = "android")]
    {
        return reqwest::Client::builder().use_preconfigured_tls(android_tls());
    }
    #[cfg(not(target_os = "android"))]
    {
        reqwest::Client::builder()
    }
}
