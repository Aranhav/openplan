use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

/// The most keys tracked at once. Keys come from clients, so the map must not
/// grow with the number of distinct emails they send.
const MAX_KEYS: usize = 10_000;

/// Sliding-window limiter for login attempts, held in memory.
pub struct LoginLimiter {
    max_failures: u32,
    window: Duration,
    attempts: Mutex<HashMap<String, Vec<Instant>>>,
}

impl LoginLimiter {
    pub fn new(max_failures: u32, window: Duration) -> Self {
        LoginLimiter {
            max_failures,
            window,
            attempts: Mutex::new(HashMap::new()),
        }
    }

    /// Counts one attempt for `key` and returns `Err(seconds)` until the next
    /// attempt is allowed when the key has used up its attempts for the current
    /// window. The attempt is reserved under the same lock as the check, so
    /// parallel requests cannot all slip past the limit before any of them
    /// fails. Call [`LoginLimiter::reset`] when the attempt succeeds.
    pub fn check_and_record(&self, key: &str) -> Result<(), u64> {
        self.check_and_record_at(key, Instant::now())
    }

    pub fn reset(&self, key: &str) {
        self.lock().remove(key);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Vec<Instant>>> {
        self.attempts.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_live(&self, attempt: Instant, now: Instant) -> bool {
        now.saturating_duration_since(attempt) < self.window
    }

    /// Frees a slot for a new key: drops the keys whose attempts have all
    /// expired and, if that frees none, the key used least recently.
    fn make_room(&self, tracked: &mut HashMap<String, Vec<Instant>>, now: Instant) {
        tracked.retain(|_, attempts| {
            attempts.retain(|&attempt| self.is_live(attempt, now));
            !attempts.is_empty()
        });
        if tracked.len() < MAX_KEYS {
            return;
        }
        let least_recent = tracked
            .iter()
            .min_by_key(|(_, attempts)| attempts.last().copied())
            .map(|(key, _)| key.clone());
        if let Some(key) = least_recent {
            tracked.remove(&key);
        }
    }

    fn check_and_record_at(&self, key: &str, now: Instant) -> Result<(), u64> {
        let mut tracked = self.lock();
        if tracked.len() >= MAX_KEYS && !tracked.contains_key(key) {
            self.make_room(&mut tracked, now);
        }
        let attempts = tracked.entry(key.to_string()).or_default();
        attempts.retain(|&attempt| self.is_live(attempt, now));
        let blocking = attempts
            .len()
            .checked_sub(self.max_failures as usize)
            .and_then(|index| attempts.get(index))
            .copied();
        if let Some(attempt) = blocking {
            let wait = (attempt + self.window).saturating_duration_since(now);
            return Err((wait.as_secs() + u64::from(wait.subsec_nanos() > 0)).max(1));
        }
        attempts.push(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_secs(900);

    fn limiter() -> LoginLimiter {
        LoginLimiter::new(3, WINDOW)
    }

    fn use_up(limiter: &LoginLimiter, key: &str, at: Instant) {
        for _ in 0..3 {
            assert_eq!(limiter.check_and_record_at(key, at), Ok(()));
        }
    }

    #[test]
    fn allows_attempts_up_to_the_limit() {
        let limiter = limiter();
        let now = Instant::now();

        use_up(&limiter, "a|1", now);

        assert!(limiter.check_and_record_at("a|1", now).is_err());
    }

    #[test]
    fn a_blocked_attempt_is_not_counted() {
        let limiter = limiter();
        let start = Instant::now();
        use_up(&limiter, "a|1", start);

        for _ in 0..5 {
            assert!(limiter.check_and_record_at("a|1", start).is_err());
        }

        assert_eq!(limiter.lock()["a|1"].len(), 3);
    }

    #[test]
    fn reports_the_wait_until_the_oldest_attempt_expires() {
        let limiter = limiter();
        let start = Instant::now();
        for offset in [0, 10, 20] {
            let at = start + Duration::from_secs(offset);
            assert_eq!(limiter.check_and_record_at("a|1", at), Ok(()));
        }

        let now = start + Duration::from_secs(100);

        assert_eq!(limiter.check_and_record_at("a|1", now), Err(800));
    }

    #[test]
    fn wait_is_rounded_up_and_at_least_one_second() {
        let limiter = limiter();
        let start = Instant::now();
        use_up(&limiter, "a|1", start);

        let almost_expired = start + WINDOW - Duration::from_millis(1);
        assert_eq!(limiter.check_and_record_at("a|1", almost_expired), Err(1));
        let just_started = start + Duration::from_millis(1);
        assert_eq!(limiter.check_and_record_at("a|1", just_started), Err(900));
    }

    #[test]
    fn attempts_expire_after_the_window() {
        let limiter = limiter();
        let start = Instant::now();
        use_up(&limiter, "a|1", start);

        assert_eq!(limiter.check_and_record_at("a|1", start + WINDOW), Ok(()));
        assert_eq!(limiter.lock()["a|1"].len(), 1);
    }

    #[test]
    fn only_attempts_inside_the_window_count() {
        let limiter = limiter();
        let start = Instant::now();
        limiter.check_and_record_at("a|1", start).unwrap();
        limiter.check_and_record_at("a|1", start).unwrap();

        use_up(&limiter, "a|1", start + WINDOW);

        assert!(limiter.check_and_record_at("a|1", start + WINDOW).is_err());
    }

    #[test]
    fn keys_are_independent() {
        let limiter = limiter();
        let now = Instant::now();
        use_up(&limiter, "a|1", now);

        assert!(limiter.check_and_record_at("a|1", now).is_err());
        assert_eq!(limiter.check_and_record_at("b|1", now), Ok(()));
        assert_eq!(limiter.check_and_record_at("a|2", now), Ok(()));
    }

    #[test]
    fn reset_clears_the_attempts() {
        let limiter = limiter();
        let now = Instant::now();
        use_up(&limiter, "a|1", now);

        limiter.reset("a|1");

        assert_eq!(limiter.check_and_record_at("a|1", now), Ok(()));
    }

    #[test]
    fn public_method_uses_the_current_time() {
        let limiter = LoginLimiter::new(1, WINDOW);

        assert_eq!(limiter.check_and_record("a|1"), Ok(()));
        assert!(matches!(limiter.check_and_record("a|1"), Err(secs) if (1..=900).contains(&secs)));
    }

    #[test]
    fn parallel_attempts_cannot_exceed_the_limit() {
        let limiter = LoginLimiter::new(10, WINDOW);

        let allowed = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..40)
                .map(|_| scope.spawn(|| limiter.check_and_record("a|1").is_ok()))
                .collect();
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .filter(|&allowed| allowed)
                .count()
        });

        assert_eq!(allowed, 10);
    }

    fn fill(limiter: &LoginLimiter, keys: std::ops::Range<usize>, at: impl Fn(usize) -> Instant) {
        for n in keys {
            limiter
                .check_and_record_at(&format!("{n}|1"), at(n))
                .unwrap();
        }
    }

    #[test]
    fn the_number_of_tracked_keys_is_capped() {
        let limiter = limiter();
        let start = Instant::now();

        fill(&limiter, 0..MAX_KEYS + 500, |_| start);

        assert_eq!(limiter.lock().len(), MAX_KEYS);
    }

    #[test]
    fn expired_keys_are_swept_before_live_ones_are_evicted() {
        let limiter = limiter();
        let start = Instant::now();
        let later = start + WINDOW - Duration::from_secs(1);
        fill(&limiter, 0..MAX_KEYS / 2, |_| start);
        fill(&limiter, MAX_KEYS / 2..MAX_KEYS, |_| later);

        limiter
            .check_and_record_at("fresh|1", start + WINDOW)
            .unwrap();

        let tracked = limiter.lock();
        assert_eq!(tracked.len(), MAX_KEYS / 2 + 1);
        assert!(tracked.contains_key("fresh|1"));
        assert!(tracked.contains_key(&format!("{}|1", MAX_KEYS - 1)));
        assert!(!tracked.contains_key("0|1"));
    }

    #[test]
    fn the_least_recently_used_key_is_evicted_when_all_are_live() {
        let limiter = limiter();
        let start = Instant::now();
        let at = |n: usize| start + Duration::from_millis(n as u64);
        fill(&limiter, 0..MAX_KEYS, at);
        limiter.check_and_record_at("0|1", at(MAX_KEYS)).unwrap();

        limiter
            .check_and_record_at("fresh|1", at(MAX_KEYS + 1))
            .unwrap();

        let tracked = limiter.lock();
        assert_eq!(tracked.len(), MAX_KEYS);
        assert!(tracked.contains_key("fresh|1"));
        assert!(
            tracked.contains_key("0|1"),
            "a recently used key was evicted"
        );
        assert!(!tracked.contains_key("1|1"));
        assert!(tracked.contains_key("2|1"));
    }

    #[test]
    fn a_tracked_key_is_never_evicted_to_make_room_for_itself() {
        let limiter = limiter();
        let start = Instant::now();
        fill(&limiter, 0..MAX_KEYS, |_| start);

        limiter.check_and_record_at("0|1", start).unwrap();

        assert_eq!(limiter.lock().len(), MAX_KEYS);
        assert_eq!(limiter.lock()["0|1"].len(), 2);
    }
}
