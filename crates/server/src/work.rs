//! A limit on the heavy work that requests ask of the server at once.
//!
//! A view query, a members call and a read of cells each run on a thread of their own and hold
//! tens of megabytes while they do, and Render's free plan has 512 MB and a fraction of a
//! processor. Each takes one of a few permits before it starts, after the caller has been checked
//! and the body read, and gives it back when it is done. A request that cannot get one within
//! ten seconds is told so with a 503 and when to try again, instead of waiting for ever.

use std::{sync::Arc, time::Duration};

use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::timeout,
};

use crate::error::{AppError, AppResult};

/// How many pieces of heavy work run at once.
const PERMITS: usize = 4;
/// How long a request waits for a permit.
const WAIT: Duration = Duration::from_secs(10);
/// What a request that gave up is told to wait before it tries again, in seconds.
const RETRY_AFTER_SECS: u64 = 2;

/// The permits for heavy work, shared by every request.
#[derive(Clone, Debug)]
pub struct Work {
    permits: Arc<Semaphore>,
    wait: Duration,
}

impl Work {
    /// `permits` pieces of work at once, each request waiting `wait` for its turn.
    pub fn new(permits: usize, wait: Duration) -> Work {
        Work {
            permits: Arc::new(Semaphore::new(permits)),
            wait,
        }
    }

    /// A permit to do one piece of work, which is given back when it is dropped; `Busy` when none
    /// is free for as long as a request waits. Take it in the handler and move it into the
    /// blocking closure, so that a client that goes away while it waits never starts the work.
    pub async fn permit(&self) -> AppResult<OwnedSemaphorePermit> {
        match timeout(self.wait, Arc::clone(&self.permits).acquire_owned()).await {
            Ok(Ok(permit)) => Ok(permit),
            _ => Err(AppError::Busy {
                retry_after_secs: RETRY_AFTER_SECS,
            }),
        }
    }
}

impl Default for Work {
    fn default() -> Self {
        Work::new(PERMITS, WAIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn work_runs_up_to_the_permits_at_once_and_the_next_waits_its_turn() {
        let work = Work::new(2, Duration::from_secs(5));
        let first = work.permit().await.unwrap();
        let _second = work.permit().await.unwrap();

        let third = tokio::spawn({
            let work = work.clone();
            async move { work.permit().await.is_ok() }
        });
        tokio::task::yield_now().await;
        assert!(!third.is_finished());
        drop(first);

        assert!(third.await.unwrap());
    }

    #[tokio::test]
    async fn a_request_that_waits_too_long_is_told_the_server_is_busy() {
        let work = Work::new(1, Duration::from_millis(50));
        let _held = work.permit().await.unwrap();

        let refused = work.permit().await.unwrap_err();

        assert!(matches!(
            refused,
            AppError::Busy {
                retry_after_secs: 2
            }
        ));
    }

    #[tokio::test]
    async fn a_permit_given_back_is_there_for_the_next() {
        let work = Work::new(1, Duration::from_millis(50));
        drop(work.permit().await.unwrap());

        assert!(work.permit().await.is_ok());
    }
}
