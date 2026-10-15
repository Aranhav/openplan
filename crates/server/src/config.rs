use std::{fmt, net::SocketAddr};

use anyhow::Context;

const DEFAULT_PORT: u16 = 8080;
const DEFAULT_LOG: &str = "info";
const DEFAULT_TRUSTED_PROXY_HOPS: u8 = 0;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub public_url: String,
    pub bind: SocketAddr,
    pub log: String,
    /// How many proxies sit in front of the server and append to `X-Forwarded-For`.
    /// Zero means the peer address is the client address.
    pub trusted_proxy_hops: u8,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("database_url", &"<redacted>")
            .field("public_url", &self.public_url)
            .field("bind", &self.bind)
            .field("log", &self.log)
            .field("trusted_proxy_hops", &self.trusted_proxy_hops)
            .finish_non_exhaustive()
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Config> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Config> {
        let value = |name: &str| get(name).filter(|v| !v.trim().is_empty());
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
        Ok(Config {
            database_url: required("DATABASE_URL")?,
            public_url: required("OPENPLAN_PUBLIC_URL")?,
            bind,
            log: value("OPENPLAN_LOG").unwrap_or_else(|| DEFAULT_LOG.to_string()),
            trusted_proxy_hops,
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
}
