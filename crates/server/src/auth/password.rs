use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};

use crate::error::{AppError, AppResult};

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

pub async fn hash_password_async(plain: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || hash_password(&plain))
        .await
        .map_err(|err| AppError::Internal(err.into()))?
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
    tokio::task::spawn_blocking(move || match hash {
        Some(hash) => verify_password(&plain, &hash),
        None => {
            verify_password(&plain, DUMMY_HASH);
            false
        }
    })
    .await
    .unwrap_or_else(|err| {
        tracing::error!("password verification task failed: {err}");
        false
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::{Algorithm, Params};

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

    #[tokio::test]
    async fn missing_hash_never_verifies() {
        assert!(!verify_password_async("anything".into(), None).await);
        assert!(!verify_password_async(String::new(), None).await);
    }
}
