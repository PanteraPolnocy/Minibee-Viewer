//! HTTP capability proxy with manual redirect handling (POST body preserved
//! across 303s, redirects off-simhost refused) and simhost IP pinning.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::{Method, Url};

use crate::bridge::util::normalize_seed_url;

/// SSRF guard for the caller-supplied `bridge_proxy` URL (to-do §13 A).
///
/// The proxy is only reachable from the app's own WebView, but it still fetches
/// an arbitrary URL, so we refuse targets that point at the local machine or a
/// private network: loopback, RFC1918, link-local, unique-local, and
/// `localhost`. Public hostnames (Agni `*.secondlife.io`, Aditi, and OpenSim
/// grids) are allowed — we do not maintain a positive host allowlist so
/// third-party OpenSim logins keep working. Returns `Some(reason)` when blocked.
pub fn egress_block_reason(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Some(format!("scheme not allowed: {other}")),
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return Some("target resolves to localhost".into());
    }
    // `url` serializes IPv6 hosts with surrounding brackets; strip for parsing.
    let host_ip = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&host);
    if let Ok(ip) = host_ip.parse::<IpAddr>() {
        if ip_is_private(&ip) {
            return Some(format!("target is a private/loopback address: {ip}"));
        }
    }
    None
}

/// Full SSRF guard: the literal/scheme/localhost check PLUS async DNS
/// resolution of a hostname target, rejecting if ANY resolved address is
/// private/loopback/link-local/metadata (audit #4). Resolution failure is not
/// treated as blocked — the subsequent connect will fail naturally.
pub async fn guard_url(url: &str) -> Result<(), String> {
    if let Some(reason) = egress_block_reason(url) {
        return Err(reason);
    }
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return Ok(()),
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_string(),
        None => return Ok(()),
    };
    // IP literals were already handled by egress_block_reason.
    let stripped = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&host);
    if stripped.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = parsed.port().unwrap_or_else(|| default_port(parsed.scheme()));
    if let Ok(addrs) = tokio::net::lookup_host((host.as_str(), port)).await {
        for a in addrs {
            if ip_is_private(&a.ip()) {
                return Err(format!("target resolves to a private/loopback address: {}", a.ip()));
            }
        }
    }
    Ok(())
}

fn ip_is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.octets()[0] == 0
                // 100.64.0.0/10 carrier-grade NAT
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // unique local fc00::/7
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // link local fe80::/10
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // IPv4-mapped: check the embedded v4
                || v6.to_ipv4().map(|m| ip_is_private(&IpAddr::V4(m))).unwrap_or(false)
        }
    }
}

pub struct ExchangeResult {
    pub status: u16,
    pub body: String,
    pub content_type: String,
    pub effective_url: String,
    pub redirect_count: u32,
}

fn is_simhost(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    // Must be a real Linden simhost, not merely anything prefixed "simhost-"
    // (which a malicious redirect could spoof, e.g. simhost-evil.attacker.com).
    h.starts_with("simhost-") && h.ends_with(".secondlife.io")
}

fn default_port(scheme: &str) -> u16 {
    if scheme.eq_ignore_ascii_case("http") {
        80
    } else {
        443
    }
}

/// Resolve a non-IP host to its first public address so the connection targets
/// the IP we validated, closing the DNS-rebinding window between guard and
/// connect. Returns None for IP-literal hosts (already guarded) or on failure.
async fn resolve_public_pin(url: &str) -> Option<(String, SocketAddr)> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_string();
    let stripped = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&host);
    if stripped.parse::<IpAddr>().is_ok() {
        return None;
    }
    let port = parsed.port().unwrap_or_else(|| default_port(parsed.scheme()));
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host(format!("{host}:{port}")).await.ok()?.collect();
    for a in addrs {
        if !ip_is_private(&a.ip()) {
            return Some((host, a));
        }
    }
    None
}

/// Resolve the pin (host -> ip) for a simhost URL so cap requests reach the
/// exact simulator. Returns the pin and the pinned IP (for reporting).
pub async fn simhost_pin(url: &str, sim_ip: &str) -> (Option<(String, SocketAddr)>, String) {
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return (None, String::new()),
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_string(),
        None => return (None, String::new()),
    };
    if !is_simhost(&host) {
        return (None, String::new());
    }
    let port = parsed.port().unwrap_or_else(|| default_port(parsed.scheme()));
    if !sim_ip.is_empty() {
        if let Ok(addr) = format!("{}:{}", sim_ip, port).parse::<SocketAddr>() {
            return (Some((host, addr)), sim_ip.to_string());
        }
    }
    if let Ok(mut addrs) = tokio::net::lookup_host(format!("{}:{}", host, port)).await {
        if let Some(addr) = addrs.find(|a| a.is_ipv4()) {
            let ip = addr.ip().to_string();
            return (Some((host, addr)), ip);
        }
    }
    (None, String::new())
}

/// Perform a cap request with manual redirects (max 6), preserving the POST
/// body across 303s and refusing redirects that leave the simhost.
#[allow(clippy::too_many_arguments)]
pub async fn exchange(
    ua: &str,
    method: &str,
    url: &str,
    payload: &str,
    content_type: &str,
    headers: &[(String, String)],
    pin: Option<(String, SocketAddr)>,
    timeout: Duration,
) -> Result<ExchangeResult, String> {
    let method_upper = method.to_ascii_uppercase();
    let is_post = method_upper == "POST";
    let mut cur_url = url.to_string();
    let mut redirects = 0u32;

    // Guard the initial target (resolves DNS + rejects private hosts); redirect
    // hops are guarded below.
    guard_url(&cur_url).await?;

    // Pin the validated address so we connect to the IP we checked rather than a
    // possibly-rebound re-resolution at connect time. Simhost pin wins if set.
    let effective_pin = match &pin {
        Some(p) => Some(p.clone()),
        None => resolve_public_pin(&cur_url).await,
    };
    let mut builder = reqwest::Client::builder()
        .user_agent(ua)
        .redirect(Policy::none())
        .gzip(true);
    if let Some((host, addr)) = &effective_pin {
        builder = builder.resolve(host, *addr);
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    // One wall-clock deadline for the whole redirect chain (up to 6 hops), so a
    // slow chain can't hold the EventQueue lane for ~6x the timeout.
    let deadline = std::time::Instant::now() + timeout;

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("Proxy timeout".into());
        }
        let m = Method::from_bytes(method_upper.as_bytes()).unwrap_or(Method::GET);
        let mut req = client.request(m, &cur_url).timeout(remaining);
        req = req.header("Accept", "application/llsd+xml, application/xml");
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if is_post {
            req = req.header("Content-Type", content_type).body(payload.to_string());
        }

        let resp = req.send().await.map_err(|e| format!("Proxy HTTP error: {e}"))?;
        let status = resp.status();
        let effective_url = resp.url().to_string();
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        if status.is_redirection() && redirects < 6 {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            if let Some(loc) = location {
                let orig_host = Url::parse(&cur_url).ok().and_then(|u| u.host_str().map(|h| h.to_string()));
                let next_abs = resolve_location(&cur_url, &loc);
                let next_host = Url::parse(&next_abs).ok().and_then(|u| u.host_str().map(|h| h.to_string()));
                if let (Some(o), Some(n)) = (&orig_host, &next_host) {
                    if !o.eq_ignore_ascii_case(n) && !is_simhost(n) {
                        return Err(format!("Seed cap redirect left simhost ({o} -> {n})"));
                    }
                }
                // Re-run the SSRF guard on the redirect target (resolves DNS),
                // so a 3xx cannot bounce us to an internal/metadata host (#4).
                guard_url(&next_abs).await?;
                cur_url = next_abs;
                redirects += 1;
                continue;
            }
        }

        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        let body = String::from_utf8_lossy(&bytes).to_string();
        return Ok(ExchangeResult {
            status: status.as_u16(),
            body,
            content_type: ctype,
            effective_url: if effective_url.is_empty() { cur_url } else { effective_url },
            redirect_count: redirects,
        });
    }
}

fn resolve_location(base: &str, location: &str) -> String {
    if Url::parse(location).is_ok() {
        return normalize_seed_url(location);
    }
    if let Ok(base_url) = Url::parse(base) {
        if let Ok(joined) = base_url.join(location) {
            return joined.to_string();
        }
    }
    location.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_public_sl_and_opensim_hosts() {
        assert!(egress_block_reason("https://simhost-01234.agni.secondlife.io:12043/cap/x").is_none());
        assert!(egress_block_reason("https://maps.secondlife.com/foo").is_none());
        assert!(egress_block_reason("http://login.osgrid.org:80/cap").is_none());
        assert!(egress_block_reason("https://8.8.8.8/cap").is_none());
    }

    #[test]
    fn blocks_loopback_and_private() {
        assert!(egress_block_reason("http://127.0.0.1:8794/proxy").is_some());
        assert!(egress_block_reason("http://localhost/x").is_some());
        assert!(egress_block_reason("http://192.168.1.10/x").is_some());
        assert!(egress_block_reason("http://10.0.0.5/x").is_some());
        assert!(egress_block_reason("http://169.254.1.1/x").is_some());
        assert!(egress_block_reason("http://[::1]/x").is_some());
        assert!(egress_block_reason("http://[fd00::1]/x").is_some());
    }

    #[test]
    fn blocks_non_http_schemes() {
        assert!(egress_block_reason("file:///etc/passwd").is_some());
        assert!(egress_block_reason("ftp://example.com/x").is_some());
    }

    #[test]
    fn is_simhost_requires_linden_domain() {
        assert!(is_simhost("simhost-08de0e0b.agni.secondlife.io"));
        // Spoof attempts that merely start with the prefix must be rejected.
        assert!(!is_simhost("simhost-evil.attacker.com"));
        assert!(!is_simhost("simhost-1234.example.org"));
        assert!(!is_simhost("maps.secondlife.com"));
    }
}
