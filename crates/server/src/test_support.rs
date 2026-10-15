//! Test doubles shared by the unit tests of several modules.

use std::{
    error::Error as StdError,
    fmt, io,
    sync::{Arc, Mutex, PoisonError},
};

use sqlx::error::{DatabaseError, ErrorKind};
use tracing_subscriber::fmt::MakeWriter;

/// The kind of database error a test wants to simulate.
#[derive(Debug)]
pub(crate) enum Violation {
    Unique,
    ForeignKey,
    Other,
}

/// A database error of a fixed kind, standing in for one Postgres reports.
#[derive(Debug)]
struct FakeDatabaseError(Violation);

impl fmt::Display for FakeDatabaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("fake database error")
    }
}

impl StdError for FakeDatabaseError {}

impl DatabaseError for FakeDatabaseError {
    fn message(&self) -> &str {
        "fake database error"
    }

    fn as_error(&self) -> &(dyn StdError + Send + Sync + 'static) {
        self
    }

    fn as_error_mut(&mut self) -> &mut (dyn StdError + Send + Sync + 'static) {
        self
    }

    fn into_error(self: Box<Self>) -> Box<dyn StdError + Send + Sync + 'static> {
        self
    }

    fn kind(&self) -> ErrorKind {
        match self.0 {
            Violation::Unique => ErrorKind::UniqueViolation,
            Violation::ForeignKey => ErrorKind::ForeignKeyViolation,
            Violation::Other => ErrorKind::Other,
        }
    }
}

/// A `sqlx::Error` that reports `violation` as its kind.
pub(crate) fn database_error(violation: Violation) -> sqlx::Error {
    sqlx::Error::Database(Box::new(FakeDatabaseError(violation)))
}

/// A log writer that keeps what it is given, for tests that read the logs.
#[derive(Clone, Default)]
pub(crate) struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl LogBuffer {
    pub(crate) fn contents(&self) -> String {
        let bytes = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

impl io::Write for LogBuffer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl MakeWriter<'_> for LogBuffer {
    type Writer = LogBuffer;

    fn make_writer(&self) -> LogBuffer {
        self.clone()
    }
}
