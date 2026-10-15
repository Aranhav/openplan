//! Test doubles shared by the unit tests of several modules.

use std::{error::Error as StdError, fmt};

use sqlx::error::{DatabaseError, ErrorKind};

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
