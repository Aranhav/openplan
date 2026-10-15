use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

/// Failure counts above this many tracked keys trigger a sweep of expired entries.
const SWEEP_THRESHOLD: usize = 10_000;

/// Sliding-window limiter for failed login attempts, held in memory.
pub struct LoginLimiter {
    max_failures: u32,
    window: Duration,
    failures: Mutex<HashMap<String, Vec<Instant>>>,
}

impl LoginLimiter {
    pub fn new(max_failures: u32, window: Duration) -> Self {
        LoginLimiter {
            max_failures,
            window,
            failures: Mutex::new(HashMap::new()),
        }
    }

    /// Returns `Err(seconds)` until the next attempt is allowed when `key` has
    /// used up its failures for the current window.
    pub fn check(&self, key: &str) -> Result<(), u64> {
        self.check_at(key, Instant::now())
    }

    pub fn record_failure(&self, key: &str) {
        self.record_failure_at(key, Instant::now());
    }

    pub fn reset(&self, key: &str) {
        self.lock().remove(key);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Vec<Instant>>> {
        self.failures.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_live(&self, failure: Instant, now: Instant) -> bool {
        now.saturating_duration_since(failure) < self.window
    }

    fn check_at(&self, key: &str, now: Instant) -> Result<(), u64> {
        let mut failures = self.lock();
        let Some(attempts) = failures.get_mut(key) else {
            return Ok(());
        };
        attempts.retain(|&failure| self.is_live(failure, now));
        let blocking = attempts
            .len()
            .checked_sub(self.max_failures as usize)
            .and_then(|index| attempts.get(index))
            .copied();
        match blocking {
            Some(failure) => {
                let wait = (failure + self.window).saturating_duration_since(now);
                Err((wait.as_secs() + u64::from(wait.subsec_nanos() > 0)).max(1))
            }
            None => {
                if attempts.is_empty() {
                    failures.remove(key);
                }
                Ok(())
            }
        }
    }

    fn record_failure_at(&self, key: &str, now: Instant) {
        let mut failures = self.lock();
        let attempts = failures.entry(key.to_string()).or_default();
        attempts.retain(|&failure| self.is_live(failure, now));
        attempts.push(now);
        if failures.len() > SWEEP_THRESHOLD {
            failures.retain(|_, attempts| {
                attempts.retain(|&failure| self.is_live(failure, now));
                !attempts.is_empty()
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_secs(900);

    fn limiter() -> LoginLimiter {
        LoginLimiter::new(3, WINDOW)
    }

    #[test]
    fn allows_attempts_below_the_limit() {
        let limiter = limiter();
        let now = Instant::now();

        limiter.record_failure_at("a|1", now);
        limiter.record_failure_at("a|1", now);

        assert_eq!(limiter.check_at("a|1", now), Ok(()));
    }

    #[test]
    fn blocks_once_the_limit_is_reached_and_reports_the_wait() {
        let limiter = limiter();
        let start = Instant::now();
        for offset in [0, 10, 20] {
            limiter.record_failure_at("a|1", start + Duration::from_secs(offset));
        }

        let now = start + Duration::from_secs(100);

        assert_eq!(limiter.check_at("a|1", now), Err(800));
    }

    #[test]
    fn wait_is_rounded_up_and_at_least_one_second() {
        let limiter = limiter();
        let start = Instant::now();
        for _ in 0..3 {
            limiter.record_failure_at("a|1", start);
        }

        let almost_expired = start + WINDOW - Duration::from_millis(1);
        assert_eq!(limiter.check_at("a|1", almost_expired), Err(1));
        let just_started = start + Duration::from_millis(1);
        assert_eq!(limiter.check_at("a|1", just_started), Err(900));
    }

    #[test]
    fn failures_expire_after_the_window() {
        let limiter = limiter();
        let start = Instant::now();
        for _ in 0..3 {
            limiter.record_failure_at("a|1", start);
        }

        assert_eq!(limiter.check_at("a|1", start + WINDOW), Ok(()));
        assert!(limiter.lock().is_empty());
    }

    #[test]
    fn only_failures_inside_the_window_count() {
        let limiter = limiter();
        let start = Instant::now();
        limiter.record_failure_at("a|1", start);
        limiter.record_failure_at("a|1", start);
        let later = start + WINDOW;
        limiter.record_failure_at("a|1", later);

        assert_eq!(limiter.check_at("a|1", later), Ok(()));
    }

    #[test]
    fn keys_are_independent() {
        let limiter = limiter();
        let now = Instant::now();
        for _ in 0..3 {
            limiter.record_failure_at("a|1", now);
        }

        assert!(limiter.check_at("a|1", now).is_err());
        assert_eq!(limiter.check_at("b|1", now), Ok(()));
        assert_eq!(limiter.check_at("a|2", now), Ok(()));
    }

    #[test]
    fn reset_clears_the_failures() {
        let limiter = limiter();
        let now = Instant::now();
        for _ in 0..3 {
            limiter.record_failure_at("a|1", now);
        }

        limiter.reset("a|1");

        assert_eq!(limiter.check_at("a|1", now), Ok(()));
    }

    #[test]
    fn public_methods_use_the_current_time() {
        let limiter = LoginLimiter::new(1, WINDOW);

        assert_eq!(limiter.check("a|1"), Ok(()));
        limiter.record_failure("a|1");
        assert!(matches!(limiter.check("a|1"), Err(secs) if (1..=900).contains(&secs)));
    }

    #[test]
    fn expired_keys_are_swept_when_many_are_tracked() {
        let limiter = limiter();
        let start = Instant::now();
        for n in 0..=SWEEP_THRESHOLD {
            limiter.record_failure_at(&format!("{n}|1"), start);
        }
        assert_eq!(limiter.lock().len(), SWEEP_THRESHOLD + 1);

        limiter.record_failure_at("fresh|1", start + WINDOW);

        assert_eq!(limiter.lock().len(), 1);
    }
}
