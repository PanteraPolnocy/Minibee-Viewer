//! HTTP capability proxy with manual redirect handling (POST body preserved
//! across 303s, redirects off-simhost refused) and simhost IP pinning.

use std::net::SocketAddr;
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::{Method, Url};

use crate::bridge::util::normalize_seed_url;

pub struct ExchangeResult {
    pub status: u16,
    pub body: String,
    pub content_type: String,
    pub effective_url: String,
    pub redirect_count: u32,
}

fn is_simhost(host: &str) -> bool {
    host.to_ascii_lowercase().starts_with("simhost-")
}

fn default_port(scheme: &str) -> u16 {
    if scheme.eq_ignore_ascii_case("http") {
        80
    } else {
        443
    }
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
    let mut builder = reqwest::Client::builder()
        .user_agent(ua)
        .redirect(Policy::none())
        .gzip(true);
    if let Some((host, addr)) = &pin {
        builder = builder.resolve(host, *addr);
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let method_upper = method.to_ascii_uppercase();
    let is_post = method_upper == "POST";
    let mut cur_url = url.to_string();
    let mut redirects = 0u32;

    loop {
        let m = Method::from_bytes(method_upper.as_bytes()).unwrap_or(Method::GET);
        let mut req = client.request(m, &cur_url).timeout(timeout);
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
