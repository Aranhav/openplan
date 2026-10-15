use std::{fmt, net::SocketAddr};

use anyhow::Context;

const DEFAULT_PORT: u16 = 8080;
const DEFAULT_LOG: &str = "info";
const DEFAULT_TRUSTED_PROXY_HOPS: u8 = 0;
const DEFAULT_DB_POOL_SIZE: u32 = 10;
const DEFAULT_MODEL_IDLE_MINUTES: u32 = 30;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub public_url: String,
    pub bind: SocketAddr,
    pub log: String,
    /// How many proxies sit in front of the server and append to `X-Forwarded-For`.
    /// Zero means the peer address is the client address.
    pub trusted_proxy_hops: u8,
    /// The most database connections the server holds open at once.
    pub db_pool_size: u32,
    /// How many minutes a model may go unused before it is saved and unloaded.
    pub model_idle_minutes: u32,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("database_url", &"<redacted>")
            .field("public_url", &self.public_url)
            .field("bind", &self.bind)
            .field("log", &self.log)
            .field("trusted_proxy_hops", &self.trusted_proxy_hops)
            .field("db_pool_size", &self.db_pool_size)
            .field("model_idle_minutes", &self.model_idle_minutes)
            .finish_non_exhaustive()
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Config> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Config> {
        let value = |name: &str| {
            get(name)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let required = |name: &str| value(name).with_context(|| format!("{name} is required"));

        // Hosts such as Render inject PORT and expect the server to listen on all interfaces.
        let bind: SocketAddr = match value("OPENPLAN_BIND") {
            Some(bind) => bind
                .parse()
                .with_context(|| format!("OPENPLAN_BIND is not a socket address: {bind}"))?,
            None => match value("PORT") {
                Some(port) => SocketAddr::from((
                    [0, 0, 0, 0],
                    port.parse::<u16>()
                        .with_context(|| format!("PORT is not a port number: {port}"))?,
                )),
                None => SocketAddr::from(([0, 0, 0, 0], DEFAULT_PORT)),
            },
        };
        let trusted_proxy_hops = match value("OPENPLAN_TRUSTED_PROXY_HOPS") {
            Some(hops) => hops.parse::<u8>().with_context(|| {
                format!("OPENPLAN_TRUSTED_PROXY_HOPS is not a number from 0 to 255: {hops}")
            })?,
            None => DEFAULT_TRUSTED_PROXY_HOPS,
        };
        let db_pool_size = match value("OPENPLAN_DB_POOL_SIZE") {
            Some(size) => size
                .parse::<u32>()
                .ok()
                .filter(|&size| size > 0)
                .with_context(|| {
                    format!("OPENPLAN_DB_POOL_SIZE is not a number greater than 0: {size}")
                })?,
            None => DEFAULT_DB_POOL_SIZE,
        };
        let model_idle_minutes = match value("OPENPLAN_MODEL_IDLE_MINUTES") {
            Some(minutes) => minutes
                .parse::<u32>()
                .ok()
                .filter(|&minutes| minutes > 0)
                .with_context(|| {
                    format!("OPENPLAN_MODEL_IDLE_MINUTES is not a number greater than 0: {minutes}")
                })?,
            None => DEFAULT_MODEL_IDLE_MINUTES,
        };
        Ok(Config {
            database_url: required("DATABASE_URL")?,
            public_url: required("OPENPLAN_PUBLIC_URL")?,
            bind,
            log: value("OPENPLAN_LOG").unwrap_or_else(|| DEFAULT_LOG.to_string()),
            trusted_proxy_hops,
            db_pool_size,
            model_idle_minutes,
        })
    }

    pub fn secure_cookies(&self) -> bool {
        self.public_url.starts_with("https://")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config_from(vars: &[(&str, &str)]) -> anyhow::Result<Config> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|name| vars.get(name).cloned())
    }

    #[test]
    fn missing_database_url_is_error() {
        let err = config_from(&[("OPENPLAN_PUBLIC_URL", "http://localhost:8080")]).unwrap_err();
        assert!(err.to_string().contains("DATABASE_URL"), "{err}");
    }

    #[test]
    fn missing_public_url_is_error() {
        let err = config_from(&[("DATABASE_URL", "postgres://localhost/openplan")]).unwrap_err();
        assert!(err.to_string().contains("OPENPLAN_PUBLIC_URL"), "{err}");
    }

    #[test]
    fn defaults_applied() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
        ])
        .unwrap();
        assert_eq!(config.bind.to_string(), "0.0.0.0:8080");
        assert_eq!(config.log, "info");
    }

    #[test]
    fn overrides_are_read() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
            ("OPENPLAN_BIND", "127.0.0.1:9000"),
            ("OPENPLAN_LOG", "debug"),
        ])
        .unwrap();
        assert_eq!(config.bind.to_string(), "127.0.0.1:9000");
        assert_eq!(config.log, "debug");
    }

    #[test]
    fn invalid_bind_is_error() {
        let err = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
            ("OPENPLAN_BIND", "not-an-address"),
        ])
        .unwrap_err();
        assert!(err.to_string().contains("OPENPLAN_BIND"), "{err}");
    }

    #[test]
    fn secure_cookies_for_https() {
        let config = |public_url: &str| {
            config_from(&[
                ("DATABASE_URL", "postgres://localhost/openplan"),
                ("OPENPLAN_PUBLIC_URL", public_url),
            ])
            .unwrap()
        };
        assert!(config("https://plan.acme.com").secure_cookies());
        assert!(!config("http://localhost:8080").secure_cookies());
    }

    #[test]
    fn debug_output_redacts_database_password() {
        let config = config_from(&[
            (
                "DATABASE_URL",
                "postgres://openplan:hunter2@localhost/openplan",
            ),
            ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
        ])
        .unwrap();

        let debug = format!("{config:?}");
        assert!(!debug.contains("hunter2"));
        assert!(debug.contains("\"<redacted>\""));
        assert!(debug.ends_with(", .. }"), "{debug}");
    }

    #[test]
    fn port_env_used_when_bind_unset() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "https://plan.acme.com"),
            ("PORT", "10000"),
        ])
        .unwrap();
        assert_eq!(config.bind.to_string(), "0.0.0.0:10000");
    }

    #[test]
    fn bind_env_wins_over_port() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "https://plan.acme.com"),
            ("OPENPLAN_BIND", "127.0.0.1:9000"),
            ("PORT", "10000"),
        ])
        .unwrap();
        assert_eq!(config.bind.to_string(), "127.0.0.1:9000");
    }

    #[test]
    fn invalid_port_is_error() {
        let err = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "https://plan.acme.com"),
            ("PORT", "http"),
        ])
        .unwrap_err();
        assert!(err.to_string().contains("PORT"), "{err}");
    }

    #[test]
    fn trusted_proxy_hops_defaults_to_zero() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
        ])
        .unwrap();
        assert_eq!(config.trusted_proxy_hops, 0);
    }

    #[test]
    fn trusted_proxy_hops_is_read() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "https://plan.acme.com"),
            ("OPENPLAN_TRUSTED_PROXY_HOPS", "2"),
        ])
        .unwrap();
        assert_eq!(config.trusted_proxy_hops, 2);
    }

    #[test]
    fn invalid_trusted_proxy_hops_is_error() {
        let err = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "https://plan.acme.com"),
            ("OPENPLAN_TRUSTED_PROXY_HOPS", "256"),
        ])
        .unwrap_err();
        assert!(
            err.to_string().contains("OPENPLAN_TRUSTED_PROXY_HOPS"),
            "{err}"
        );
    }

    #[test]
    fn db_pool_size_defaults_to_ten() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
        ])
        .unwrap();
        assert_eq!(config.db_pool_size, 10);
    }

    #[test]
    fn db_pool_size_is_read_and_trimmed() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
            ("OPENPLAN_DB_POOL_SIZE", " 4 "),
        ])
        .unwrap();
        assert_eq!(config.db_pool_size, 4);
    }

    #[test]
    fn invalid_db_pool_size_is_error() {
        for size in ["0", "-1", "many", "4.5"] {
            let err = config_from(&[
                ("DATABASE_URL", "postgres://localhost/openplan"),
                ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
                ("OPENPLAN_DB_POOL_SIZE", size),
            ])
            .unwrap_err();
            assert!(err.to_string().contains("OPENPLAN_DB_POOL_SIZE"), "{err}");
        }
    }

    #[test]
    fn model_idle_minutes_defaults_to_thirty() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
        ])
        .unwrap();
        assert_eq!(config.model_idle_minutes, 30);
    }

    #[test]
    fn model_idle_minutes_is_read_and_trimmed() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
            ("OPENPLAN_MODEL_IDLE_MINUTES", " 5 "),
        ])
        .unwrap();
        assert_eq!(config.model_idle_minutes, 5);
    }

    #[test]
    fn invalid_model_idle_minutes_is_error() {
        for minutes in ["0", "-1", "soon", "1.5"] {
            let err = config_from(&[
                ("DATABASE_URL", "postgres://localhost/openplan"),
                ("OPENPLAN_PUBLIC_URL", "http://localhost:8080"),
                ("OPENPLAN_MODEL_IDLE_MINUTES", minutes),
            ])
            .unwrap_err();
            assert!(
                err.to_string().contains("OPENPLAN_MODEL_IDLE_MINUTES"),
                "{err}"
            );
        }
    }

    #[test]
    fn blank_bind_falls_through_to_port() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "https://plan.acme.com"),
            ("OPENPLAN_BIND", "  "),
            ("PORT", "10000"),
        ])
        .unwrap();
        assert_eq!(config.bind.to_string(), "0.0.0.0:10000");
    }

    #[test]
    fn surrounding_whitespace_is_ignored() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "https://plan.acme.com"),
            ("OPENPLAN_BIND", " 127.0.0.1:9000 "),
            ("OPENPLAN_TRUSTED_PROXY_HOPS", " 2 "),
        ])
        .unwrap();
        assert_eq!(config.bind.to_string(), "127.0.0.1:9000");
        assert_eq!(config.trusted_proxy_hops, 2);
    }

    #[test]
    fn port_is_trimmed() {
        let config = config_from(&[
            ("DATABASE_URL", "postgres://localhost/openplan"),
            ("OPENPLAN_PUBLIC_URL", "https://plan.acme.com"),
            ("PORT", " 10000 "),
        ])
        .unwrap();
        assert_eq!(config.bind.to_string(), "0.0.0.0:10000");
    }
}
