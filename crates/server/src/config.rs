use std::net::SocketAddr;

use anyhow::Context;

const DEFAULT_BIND: &str = "0.0.0.0:8080";
const DEFAULT_LOG: &str = "info";

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub public_url: String,
    pub bind: SocketAddr,
    pub log: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Config> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Config> {
        let value = |name: &str| get(name).filter(|v| !v.trim().is_empty());
        let required = |name: &str| value(name).with_context(|| format!("{name} is required"));

        let bind = value("OPENPLAN_BIND").unwrap_or_else(|| DEFAULT_BIND.to_string());
        Ok(Config {
            database_url: required("DATABASE_URL")?,
            public_url: required("OPENPLAN_PUBLIC_URL")?,
            bind: bind
                .parse()
                .with_context(|| format!("OPENPLAN_BIND is not a socket address: {bind}"))?,
            log: value("OPENPLAN_LOG").unwrap_or_else(|| DEFAULT_LOG.to_string()),
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
}
