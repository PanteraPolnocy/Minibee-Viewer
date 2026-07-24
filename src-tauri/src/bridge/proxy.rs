//! HTTP capability proxy. Redirects are handled by hand (the POST body survives
//! a 303, and redirects off-simhost are refused), with simhost IP pinning.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::{Method, Url};

use crate::bridge::util::normalize_seed_url;

/// SSRF guard for caller-supplied `bridge_proxy` URLs. Rejects loopback and private targets.
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
    // `url` wraps IPv6 hosts in brackets when it serializes them, so strip those before parsing.
    let host_ip = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&host);
    if let Ok(ip) = host_ip.parse::<IpAddr>() {
        if ip_is_private(&ip) {
            return Some(format!("target is a private/loopback address: {ip}"));
        }
    }
    None
}

/// The full SSRF guard: the literal check plus async DNS resolution.
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
    // IP literals were already taken care of by egress_block_reason.
    let stripped = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&host);
    if stripped.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = parsed.port().unwrap_or_else(|| default_port(parsed.scheme()));
    // Fail closed: if the name won't resolve, we'd rather refuse than let the
    // fetch proceed against an address we never vetted.
    let addrs = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("could not resolve target host {host}: {e}"))?;
    let mut any = false;
    for a in addrs {
        any = true;
        if ip_is_private(&a.ip()) {
            return Err(format!("target resolves to a private/loopback address: {}", a.ip()));
        }
    }
    if !any {
        return Err(format!("target host {host} resolved to no addresses"));
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
                // carrier-grade NAT (100.64.0.0/10)
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            // 6to4 (2002::/16) tucks an IPv4 address into bits 16-48.
            if seg[0] == 0x2002 {
                let v4 = Ipv4Addr::from((((seg[1] as u32) << 16) | seg[2] as u32).to_be_bytes());
                if ip_is_private(&IpAddr::V4(v4)) {
                    return true;
                }
            }
            // Teredo (2001:0000::/32) hides the client IPv4 in the last 32 bits,
            // bitwise-inverted; a tunnel to an internal client has to be refused.
            if seg[0] == 0x2001 && seg[1] == 0x0000 {
                let client = !(((seg[6] as u32) << 16) | seg[7] as u32);
                if ip_is_private(&IpAddr::V4(Ipv4Addr::from(client.to_be_bytes()))) {
                    return true;
                }
            }
            // The NAT64 well-known prefix (64:ff9b::/96) carries an IPv4 in the last
            // 32 bits; on a network with a NAT64 gateway, that could actually reach it.
            if seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2..6].iter().all(|&s| s == 0) {
                let v4 = Ipv4Addr::from((((seg[6] as u32) << 16) | seg[7] as u32).to_be_bytes());
                if ip_is_private(&IpAddr::V4(v4)) {
                    return true;
                }
            }
            v6.is_loopback()
                || v6.is_unspecified()
                // unique-local range, fc00::/7
                || (seg[0] & 0xfe00) == 0xfc00
                // link-local range, fe80::/10
                || (seg[0] & 0xffc0) == 0xfe80
                // IPv4-mapped or -compatible: check the v4 embedded inside
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
    // Has to be a genuine Linden simhost, not just anything that starts with
    // "simhost-" (a malicious redirect could spoof that, e.g. simhost-evil.attacker.com).
    h.starts_with("simhost-") && h.ends_with(".secondlife.io")
}

fn default_port(scheme: &str) -> u16 {
    if scheme.eq_ignore_ascii_case("http") {
        80
    } else {
        443
    }
}

/// Pin a URL to the IP we already validated, closing the DNS-rebinding window.
pub(crate) async fn resolve_public_pin(url: &str) -> Option<(String, SocketAddr)> {
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

/// Work out the simhost pin for cap requests. Returns (pin, pinned IP).
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
    // sim_ip comes from the remote side (login / TeleportFinish / CrossedRegion), so
    // never pin to it when it points at a private/loopback address - otherwise the
    // guard validates the public DNS while the connection is quietly rerouted
    // internally (SSRF). The DNS fallback below follows the same rule.
    if !sim_ip.is_empty() {
        if let Ok(addr) = format!("{}:{}", sim_ip, port).parse::<SocketAddr>() {
            if !ip_is_private(&addr.ip()) {
                return (Some((host, addr)), sim_ip.to_string());
            }
        }
    }
    if let Ok(addrs) = tokio::net::lookup_host(format!("{}:{}", host, port)).await {
        if let Some(addr) = addrs.filter(|a| a.is_ipv4()).find(|a| !ip_is_private(&a.ip())) {
            let ip = addr.ip().to_string();
            return (Some((host, addr)), ip);
        }
    }
    (None, String::new())
}

/// Cap request that follows redirects by hand (POST preserved, off-simhost refused).
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
    guard_initial: bool,
) -> Result<ExchangeResult, String> {
    let method_upper = method.to_ascii_uppercase();
    let is_post = method_upper == "POST";
    let mut cur_url = url.to_string();
    let mut redirects = 0u32;

    // Guard the initial target (resolves DNS and rejects private hosts); the redirect
    // hops are always guarded further down. `guard_initial` is false only for the
    // user-chosen login endpoint, which may legitimately be a loopback/LAN OpenSim
    // grid - that host is the user's own choice, not attacker-supplied.
    if guard_initial {
        guard_url(&cur_url).await?;
    } else if let Some(reason) = egress_block_reason(&cur_url) {
        // Even for the login endpoint, still refuse non-http(s) schemes.
        if reason.contains("scheme") {
            return Err(reason);
        }
    }

    // Pin the validated address so we connect to the IP we actually checked, not a
    // possibly-rebound re-resolution at connect time. A simhost pin wins if it's set.
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

    // A single wall-clock deadline covers the whole redirect chain (up to 6 hops), so
    // a slow chain can't tie up the EventQueue lane for ~6x the timeout.
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
                    // Keep simhost traffic on simhosts: a sim must never redirect its
                    // cap/EventQueue calls off to some other host. Non-simhost origins
                    // (login servers, general caps) are free to follow cross-host public
                    // redirects - each hop is still SSRF-guarded by guard_url below.
                    if is_simhost(o) && !o.eq_ignore_ascii_case(n) && !is_simhost(n) {
                        return Err(format!("simhost redirect left the sim ({o} -> {n})"));
                    }
                }
                // Re-run the SSRF guard on the redirect target (this resolves DNS),
                // so a 3xx can't bounce us onto an internal or metadata host.
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
    fn blocks_ipv6_tunnels_wrapping_private_v4() {
        // 6to4 (2002::/16) that embeds 10.0.0.1 -> 2002:0a00:0001::
        assert!(egress_block_reason("http://[2002:0a00:0001::]/x").is_some());
        // 6to4 that embeds a public v4 (8.8.8.8 -> 2002:0808:0808::) stays allowed.
        assert!(egress_block_reason("http://[2002:0808:0808::]/x").is_none());
        // Teredo (2001:0000::/32) carrying client v4 = 192.168.0.1. The client field
        // is the inverted last 32 bits: ~0xC0A80001 = 0x3F57FFFE.
        assert!(egress_block_reason("http://[2001:0000:4136:e378:8000:63bf:3f57:fffe]/x").is_some());
    }

    #[test]
    fn blocks_non_http_schemes() {
        assert!(egress_block_reason("file:///etc/passwd").is_some());
        assert!(egress_block_reason("ftp://example.com/x").is_some());
    }

    #[test]
    fn is_simhost_requires_linden_domain() {
        assert!(is_simhost("simhost-08de0e0b.agni.secondlife.io"));
        // Anything that merely starts with the prefix is a spoof attempt, so reject it.
        assert!(!is_simhost("simhost-evil.attacker.com"));
        assert!(!is_simhost("simhost-1234.example.org"));
        assert!(!is_simhost("maps.secondlife.com"));
    }
}
