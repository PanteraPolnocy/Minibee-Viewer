//! A cheap global traffic meter. The UDP circuit and the HTTP proxy report
//! byte counts here, each on its own lane; a throttled task turns the totals
//! into rates for the top-bar indicator, and the per-lane totals since launch
//! say where a day's traffic went. Global atomics are fine: there is one live
//! session, and being off by a packet during reconnect hurts nothing.
//!
//! Not counted: the voice call and the parcel music stream, which the
//! WebView carries itself (WebRTC and an audio element), never this core.

use std::sync::atomic::{AtomicU64, Ordering};

/// Who moved the bytes: the sim's UDP circuit, or an HTTP exchange (caps,
/// the EventQueue long-poll, textures, the map, profiles...).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Udp,
    Http,
}

static UDP_IN: AtomicU64 = AtomicU64::new(0);
static UDP_OUT: AtomicU64 = AtomicU64::new(0);
static HTTP_IN: AtomicU64 = AtomicU64::new(0);
static HTTP_OUT: AtomicU64 = AtomicU64::new(0);

pub fn note_in(lane: Lane, bytes: usize) {
    let counter = match lane {
        Lane::Udp => &UDP_IN,
        Lane::Http => &HTTP_IN,
    };
    counter.fetch_add(bytes as u64, Ordering::Relaxed);
}

pub fn note_out(lane: Lane, bytes: usize) {
    let counter = match lane {
        Lane::Udp => &UDP_OUT,
        Lane::Http => &HTTP_OUT,
    };
    counter.fetch_add(bytes as u64, Ordering::Relaxed);
}

/// Current totals `(in, out)` across both lanes, for delta-based rate computation.
pub fn totals() -> (u64, u64) {
    let (udp_in, udp_out) = lane_totals(Lane::Udp);
    let (http_in, http_out) = lane_totals(Lane::Http);
    (udp_in + http_in, udp_out + http_out)
}

/// Current totals `(in, out)` of one lane.
pub fn lane_totals(lane: Lane) -> (u64, u64) {
    match lane {
        Lane::Udp => (UDP_IN.load(Ordering::Relaxed), UDP_OUT.load(Ordering::Relaxed)),
        Lane::Http => (HTTP_IN.load(Ordering::Relaxed), HTTP_OUT.load(Ordering::Relaxed)),
    }
}

/// A rate as humans read it: B/s below a KB, one decimal above.
pub fn format_rate(bps: u64) -> String {
    if bps >= 1_048_576 {
        format!("{:.1} MB/s", bps as f64 / 1_048_576.0)
    } else if bps >= 1024 {
        format!("{:.1} KB/s", bps as f64 / 1024.0)
    } else {
        format!("{} B/s", bps)
    }
}

/// A byte count as humans read it: B below a KB, one decimal above, up to GB.
pub fn format_bytes(bytes: u64) -> String {
    const GB: f64 = 1_073_741_824.0;
    const MB: f64 = 1_048_576.0;
    if bytes as f64 >= GB {
        format!("{:.2} GB", bytes as f64 / GB)
    } else if bytes as f64 >= MB {
        format!("{:.1} MB", bytes as f64 / MB)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

/// The totals since launch, ready for a tooltip: overall down/up, then the
/// split between the sim circuit and HTTP, e.g.
/// "Since launch: ↓ 120.4 MB  ↑ 8.1 MB (circuit ↓ 110.2 MB ↑ 7.0 MB, HTTP ↓ 10.2 MB ↑ 1.1 MB)".
pub fn totals_label() -> String {
    let (udp_in, udp_out) = lane_totals(Lane::Udp);
    let (http_in, http_out) = lane_totals(Lane::Http);
    format!(
        "Since launch: \u{2193} {}  \u{2191} {} (circuit \u{2193} {} \u{2191} {}, HTTP \u{2193} {} \u{2191} {})",
        format_bytes(udp_in + http_in),
        format_bytes(udp_out + http_out),
        format_bytes(udp_in),
        format_bytes(udp_out),
        format_bytes(http_in),
        format_bytes(http_out)
    )
}

/// Throughput squashed to 0..1 for the meter bar, log-scaled: ~1 KB/s barely
/// registers, ~1 MB/s pegs the bar. A session idles around a few KB/s and
/// object-heavy scenes hit hundreds, so a linear bar would sit at zero all day.
pub fn rate_level(total_bps: u64) -> f64 {
    if total_bps == 0 {
        return 0.0;
    }
    ((1.0 + total_bps as f64 / 1024.0).log10() / 3.0).min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_accumulate_per_lane_and_overall() {
        let (i0, o0) = totals();
        let (u0, _) = lane_totals(Lane::Udp);
        let (_, h0) = lane_totals(Lane::Http);
        note_in(Lane::Udp, 1500);
        note_out(Lane::Http, 300);
        let (i1, o1) = totals();
        assert!(i1 >= i0 + 1500);
        assert!(o1 >= o0 + 300);
        assert!(lane_totals(Lane::Udp).0 >= u0 + 1500);
        assert!(lane_totals(Lane::Http).1 >= h0 + 300);
        // Other tests add to the counters in parallel, so only the growth
        // is checked - and the label always carries every part.
        let label = totals_label();
        assert!(label.starts_with("Since launch: \u{2193} "), "{label}");
        assert!(label.contains("(circuit \u{2193} ") && label.contains(", HTTP \u{2193} "), "{label}");
    }

    #[test]
    fn format_rate_picks_the_readable_unit() {
        assert_eq!(format_rate(0), "0 B/s");
        assert_eq!(format_rate(1023), "1023 B/s");
        assert_eq!(format_rate(1024), "1.0 KB/s");
        assert_eq!(format_rate(154_000), "150.4 KB/s");
        assert_eq!(format_rate(1_048_576), "1.0 MB/s");
        assert_eq!(format_rate(5 * 1_048_576 + 524_288), "5.5 MB/s");
    }

    #[test]
    fn format_bytes_picks_the_readable_unit() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1_048_576), "1.0 MB");
        assert_eq!(format_bytes(120 * 1_048_576 + 419_430), "120.4 MB");
        assert_eq!(format_bytes(2 * 1_073_741_824), "2.00 GB");
        assert_eq!(format_bytes(2_254_857_830), "2.10 GB");
    }

    #[test]
    fn rate_level_is_log_scaled_and_clamped() {
        assert_eq!(rate_level(0), 0.0);
        let idle = rate_level(1024); // ~1 KB/s: visible but low
        assert!(idle > 0.05 && idle < 0.2, "idle level {idle}");
        let busy = rate_level(100 * 1024); // ~100 KB/s: well up the bar
        assert!(busy > 0.6 && busy < 0.75, "busy level {busy}");
        assert_eq!(rate_level(1_048_576), 1.0); // ~1 MB/s pegs it
        assert_eq!(rate_level(u64::MAX), 1.0); // and it never overshoots
        // Monotonic: more traffic never shows a smaller bar.
        assert!(rate_level(2048) > rate_level(1024));
    }
}
