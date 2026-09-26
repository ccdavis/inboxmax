use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_MAX_FAILURES: u32 = 10;
const DEFAULT_WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_TRACKED_KEYS: usize = 10_000;

/// Counts failed password attempts per key (an account or user) in a fixed
/// window, so credentials cannot be guessed at full speed.
#[derive(Clone)]
pub struct AttemptLimiter {
    windows: Arc<Mutex<HashMap<String, Window>>>,
    max_failures: u32,
    window: Duration,
}

struct Window {
    started: Instant,
    failures: u32,
}

impl AttemptLimiter {
    pub fn new() -> Self {
        Self::with_limits(DEFAULT_MAX_FAILURES, DEFAULT_WINDOW)
    }

    pub fn with_limits(max_failures: u32, window: Duration) -> Self {
        Self {
            windows: Arc::new(Mutex::new(HashMap::new())),
            max_failures: max_failures.max(1),
            window,
        }
    }

    /// Reject the attempt if `key` has used up its failures for this window.
    pub fn check(&self, key: &str) -> AppResult<()> {
        let windows = self.windows.lock().expect("limiter lock poisoned");
        match windows.get(key) {
            Some(w) if w.started.elapsed() < self.window && w.failures >= self.max_failures => {
                Err(AppError::TooManyRequests)
            }
            _ => Ok(()),
        }
    }

    pub fn record_failure(&self, key: &str) {
        let mut windows = self.windows.lock().expect("limiter lock poisoned");
        if windows.len() >= MAX_TRACKED_KEYS && !windows.contains_key(key) {
            windows.retain(|_, w| w.started.elapsed() < self.window);
            if windows.len() >= MAX_TRACKED_KEYS
                && let Some(oldest) = windows
                    .iter()
                    .min_by_key(|(_, w)| w.started)
                    .map(|(k, _)| k.clone())
            {
                windows.remove(&oldest);
            }
        }
        let window = windows.entry(key.to_string()).or_insert(Window {
            started: Instant::now(),
            failures: 0,
        });
        if window.started.elapsed() >= self.window {
            window.started = Instant::now();
            window.failures = 0;
        }
        window.failures += 1;
    }

    /// Forget failures after a successful attempt.
    pub fn reset(&self, key: &str) {
        self.windows
            .lock()
            .expect("limiter lock poisoned")
            .remove(key);
    }
}

impl Default for AttemptLimiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::AttemptLimiter;
    use std::time::Duration;

    #[test]
    fn blocks_after_the_failure_limit_until_reset() {
        let limiter = AttemptLimiter::with_limits(2, Duration::from_secs(60));
        limiter.record_failure("a");
        assert!(limiter.check("a").is_ok());
        limiter.record_failure("a");
        assert!(limiter.check("a").is_err());
        assert!(limiter.check("b").is_ok(), "keys are independent");
        limiter.reset("a");
        assert!(limiter.check("a").is_ok());
    }

    #[test]
    fn failures_expire_with_the_window() {
        let limiter = AttemptLimiter::with_limits(1, Duration::ZERO);
        limiter.record_failure("a");
        assert!(limiter.check("a").is_ok());
    }
}
