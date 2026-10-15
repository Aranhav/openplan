use std::io::{self, IsTerminal};

use anyhow::Context;
use tracing::Subscriber;
use tracing_subscriber::{EnvFilter, fmt::MakeWriter};

/// Starts logging to stdout with the given `OPENPLAN_LOG` filter. Colours are
/// only used when stdout is a terminal, so that log collectors such as
/// Render's do not receive escape codes.
pub fn init(filter: &str) -> anyhow::Result<()> {
    let filter = EnvFilter::try_new(filter)
        .with_context(|| format!("OPENPLAN_LOG is not a valid filter: {filter}"))?;
    let subscriber = subscriber(filter, io::stdout().is_terminal(), io::stdout);
    tracing::subscriber::set_global_default(subscriber)
        .context("failed to install the log subscriber")
}

pub(crate) fn subscriber<W>(
    filter: EnvFilter,
    ansi: bool,
    writer: W,
) -> impl Subscriber + Send + Sync
where
    W: for<'writer> MakeWriter<'writer> + Send + Sync + 'static,
{
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(ansi)
        .with_writer(writer)
        .finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::LogBuffer;

    fn logged_line(ansi: bool) -> String {
        let buffer = LogBuffer::default();
        let subscriber = subscriber(EnvFilter::new("info"), ansi, buffer.clone());
        tracing::subscriber::with_default(subscriber, || tracing::info!("hello"));
        buffer.contents()
    }

    #[test]
    fn colours_are_left_out_unless_asked_for() {
        assert!(!logged_line(false).contains('\x1b'));
        assert!(logged_line(true).contains('\x1b'));
    }

    #[test]
    fn an_invalid_filter_is_an_error_naming_the_variable() {
        let err = init("openplan=nonsense=").unwrap_err();

        assert!(err.to_string().contains("OPENPLAN_LOG"), "{err}");
    }
}
