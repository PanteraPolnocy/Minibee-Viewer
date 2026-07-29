//! A cheap global traffic meter. The UDP circuit and the HTTP proxy report
//! byte counts here; a throttled task turns the totals into rates for the
//! top-bar indicator. Global atomics are fine: there is one live session, and
//! being off by a packet during reconnect hurts nothing.

use std::sync::atomic::{AtomicU64, Ordering};

static BYTES_IN: AtomicU64 = AtomicU64::new(0);
static BYTES_OUT: AtomicU64 = AtomicU64::new(0);

pub fn note_in(bytes: usize) {
    BYTES_IN.fetch_add(bytes as u64, Ordering::Relaxed);
}

pub fn note_out(bytes: usize) {
    BYTES_OUT.fetch_add(bytes as u64, Ordering::Relaxed);
}

/// Current totals `(in, out)`, for delta-based rate computation.
pub fn totals() -> (u64, u64) {
    (BYTES_IN.load(Ordering::Relaxed), BYTES_OUT.load(Ordering::Relaxed))
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
    fn totals_accumulate() {
        let (i0, o0) = totals();
        note_in(1500);
        note_out(300);
        let (i1, o1) = totals();
        assert!(i1 >= i0 + 1500);
        assert!(o1 >= o0 + 300);
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
