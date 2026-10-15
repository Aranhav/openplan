use std::{
    num::NonZeroUsize,
    sync::{Arc, LazyLock},
};

use anyhow::Context;
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use tokio::sync::Semaphore;

use crate::error::{AppError, AppResult};

/// Caps how many Argon2 computations run at once. Each one needs about 19 MiB,
/// so without a cap a burst of unauthenticated logins could exhaust memory.
static HASHING_PERMITS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| {
    let cores = std::thread::available_parallelism().map_or(1, NonZeroUsize::get);
    Arc::new(Semaphore::new(cores))
});

/// An argon2id hash made with the default parameters. Verifying against it
/// when no account matches keeps login timing the same for unknown users.
const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$k9XQ4Bl9wc39mUjQEN5fsA$dPbpCjdzCErF09MarwKpYiU/+oldbtJKB49jw9Yop3E";

pub fn hash_password(plain: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| AppError::Internal(anyhow::anyhow!("password hashing failed: {err}")))
}

/// Runs `work` on a blocking thread once a permit is free. The permit moves
/// into the blocking task, so it is held until the work really ends even if
/// the caller is cancelled in the meantime.
async fn run_limited<T, F>(permits: &Arc<Semaphore>, work: F) -> anyhow::Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let permit = Arc::clone(permits)
        .acquire_owned()
        .await
        .context("the password hashing limiter is closed")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .context("the password hashing task failed")
}

pub async fn hash_password_async(plain: String) -> AppResult<String> {
    run_limited(&HASHING_PERMITS, move || hash_password(&plain))
        .await
        .map_err(AppError::Internal)?
}

pub fn verify_password(plain: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| {
            Argon2::default()
                .verify_password(plain.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

/// Verifies `plain` against `hash`. With no hash it still spends the same time
/// on a dummy verification and returns `false`.
pub async fn verify_password_async(plain: String, hash: Option<String>) -> bool {
    run_limited(&HASHING_PERMITS, move || match hash {
        Some(hash) => verify_password(&plain, &hash),
        None => {
            verify_password(&plain, DUMMY_HASH);
            false
        }
    })
    .await
    .unwrap_or_else(|err| {
        tracing::error!("password verification failed: {err:#}");
        false
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::{Algorithm, Params};
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    #[test]
    fn hash_then_verify() {
        let hash = hash_password("correct horse battery").unwrap();

        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("correct horse battery", &hash));
    }

    #[test]
    fn verify_rejects_wrong() {
        let hash = hash_password("correct horse battery").unwrap();

        assert!(!verify_password("incorrect horse battery", &hash));
        assert!(!verify_password("", &hash));
    }

    #[test]
    fn verify_rejects_malformed_hash() {
        assert!(!verify_password("anything", "not a phc string"));
        assert!(!verify_password("anything", ""));
    }

    #[test]
    fn hashes_are_salted() {
        let first = hash_password("correct horse battery").unwrap();
        let second = hash_password("correct horse battery").unwrap();

        assert_ne!(first, second);
    }

    #[test]
    fn dummy_hash_uses_the_current_default_parameters() {
        let dummy = PasswordHash::new(DUMMY_HASH).unwrap();
        let real_hash = hash_password("x").unwrap();
        let real = PasswordHash::new(&real_hash).unwrap();

        assert_eq!(dummy.algorithm, Algorithm::Argon2id.ident());
        assert_eq!(dummy.version, real.version);
        assert_eq!(
            Params::try_from(&dummy).unwrap(),
            Params::try_from(&real).unwrap()
        );
    }

    #[tokio::test]
    async fn async_wrappers_agree_with_the_sync_functions() {
        let hash = hash_password_async("correct horse battery".into())
            .await
            .unwrap();

        assert!(verify_password_async("correct horse battery".into(), Some(hash.clone())).await);
        assert!(!verify_password_async("wrong password".into(), Some(hash)).await);
    }

    async fn max_concurrent_runs(permits: usize, jobs: usize) -> usize {
        let limit = Arc::new(Semaphore::new(permits));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let mut running = tokio::task::JoinSet::new();
        for _ in 0..jobs {
            let (limit, in_flight, max_seen) = (limit.clone(), in_flight.clone(), max_seen.clone());
            running.spawn(async move {
                run_limited(&limit, move || {
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(40));
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                })
                .await
                .unwrap();
            });
        }
        while let Some(done) = running.join_next().await {
            done.unwrap();
        }
        max_seen.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn one_permit_runs_hashing_work_sequentially() {
        assert_eq!(max_concurrent_runs(1, 4).await, 1);
    }

    #[tokio::test]
    async fn work_runs_in_parallel_up_to_the_permit_count() {
        assert_eq!(max_concurrent_runs(2, 4).await, 2);
    }

    #[tokio::test]
    async fn a_cancelled_caller_keeps_its_permit_until_the_work_ends() {
        let limit = Arc::new(Semaphore::new(1));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn({
            let limit = limit.clone();
            async move {
                run_limited(&limit, move || {
                    started_tx.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(150));
                })
                .await
            }
        });
        started_rx.await.unwrap();

        caller.abort();

        assert_eq!(limit.available_permits(), 0);
        let _permit = tokio::time::timeout(Duration::from_secs(5), limit.acquire())
            .await
            .expect("the permit is released when the work ends")
            .unwrap();
    }

    #[tokio::test]
    async fn missing_hash_never_verifies() {
        assert!(!verify_password_async("anything".into(), None).await);
        assert!(!verify_password_async(String::new(), None).await);
    }
}
