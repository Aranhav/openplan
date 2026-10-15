use crate::error::{AppError, AppResult, FieldError};

const EMAIL_MAX: usize = 254;
const PERSON_NAME_MAX: usize = 100;
const PASSWORD_MIN: usize = 10;
const PASSWORD_MAX: usize = 256;
const ENTITY_NAME_MAX: usize = 80;

fn field_error(field: &str, message: String) -> FieldError {
    FieldError {
        field: field.to_string(),
        message,
    }
}

/// Capitalizes a snake_case field name for use at the start of a message.
fn label(field: &str) -> String {
    let spaced = field.replace('_', " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => spaced,
    }
}

fn trimmed_name(field: &str, raw: &str, max: usize) -> Result<String, FieldError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(field_error(field, format!("{} is required.", label(field))));
    }
    if name.chars().count() > max {
        return Err(field_error(
            field,
            format!("{} must be at most {max} characters.", label(field)),
        ));
    }
    Ok(name.to_string())
}

pub fn email(raw: &str) -> Result<String, FieldError> {
    let email = raw.trim().to_lowercase();
    if email.chars().count() > EMAIL_MAX {
        return Err(field_error(
            "email",
            format!("Email must be at most {EMAIL_MAX} characters."),
        ));
    }
    match email.split_once('@') {
        Some((local, domain))
            if !local.is_empty() && !domain.is_empty() && !domain.contains('@') =>
        {
            Ok(email)
        }
        _ => Err(field_error("email", "Enter a valid email address.".into())),
    }
}

pub fn person_name(raw: &str) -> Result<String, FieldError> {
    trimmed_name("name", raw, PERSON_NAME_MAX)
}

pub fn password(raw: &str) -> Result<(), FieldError> {
    let length = raw.chars().count();
    if length < PASSWORD_MIN {
        return Err(field_error(
            "password",
            format!("Password must be at least {PASSWORD_MIN} characters."),
        ));
    }
    if length > PASSWORD_MAX {
        return Err(field_error(
            "password",
            format!("Password must be at most {PASSWORD_MAX} characters."),
        ));
    }
    Ok(())
}

pub fn entity_name(field: &str, raw: &str) -> Result<String, FieldError> {
    trimmed_name(field, raw, ENTITY_NAME_MAX)
}

/// Fails with every collected field error, or succeeds when there are none.
pub fn collect(results: Vec<Result<(), FieldError>>) -> AppResult<()> {
    let errors: Vec<FieldError> = results.into_iter().filter_map(Result::err).collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(AppError::Validation(errors))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(result: Result<impl std::fmt::Debug, FieldError>) -> String {
        result.unwrap_err().message
    }

    #[test]
    fn email_is_trimmed_and_lowercased() {
        assert_eq!(email("  Ada@Acme.COM ").unwrap(), "ada@acme.com");
    }

    #[test]
    fn email_requires_one_at_with_non_empty_parts() {
        for bad in ["", "   ", "ada", "@acme.com", "ada@", "a@b@c.com", "@"] {
            let err = email(bad).unwrap_err();
            assert_eq!(err.field, "email", "{bad:?}");
            assert_eq!(err.message, "Enter a valid email address.", "{bad:?}");
        }
    }

    #[test]
    fn email_length_limit_is_254_characters() {
        let at_limit = format!("{}@acme.com", "a".repeat(254 - "@acme.com".len()));
        assert!(email(&at_limit).is_ok());
        let over = format!("{}@acme.com", "a".repeat(255 - "@acme.com".len()));
        assert_eq!(
            message(email(&over)),
            "Email must be at most 254 characters."
        );
    }

    #[test]
    fn person_name_is_trimmed_and_limited_to_100_characters() {
        assert_eq!(person_name("  Ada Lovelace ").unwrap(), "Ada Lovelace");
        assert_eq!(message(person_name("   ")), "Name is required.");
        assert!(person_name(&"é".repeat(100)).is_ok());
        let err = person_name(&"é".repeat(101)).unwrap_err();
        assert_eq!(err.field, "name");
        assert_eq!(err.message, "Name must be at most 100 characters.");
    }

    #[test]
    fn password_length_is_10_to_256_characters() {
        assert_eq!(
            message(password(&"a".repeat(9))),
            "Password must be at least 10 characters."
        );
        assert!(password(&"a".repeat(10)).is_ok());
        assert!(password(&"a".repeat(256)).is_ok());
        let err = password(&"a".repeat(257)).unwrap_err();
        assert_eq!(err.field, "password");
        assert_eq!(err.message, "Password must be at most 256 characters.");
    }

    #[test]
    fn password_is_not_trimmed() {
        assert!(password("          ").is_ok());
    }

    #[test]
    fn entity_name_is_trimmed_and_limited_to_80_characters() {
        assert_eq!(entity_name("name", "  Acme ").unwrap(), "Acme");
        assert!(entity_name("name", &"a".repeat(80)).is_ok());
        let err = entity_name("workspace_name", &"a".repeat(81)).unwrap_err();
        assert_eq!(err.field, "workspace_name");
        assert_eq!(err.message, "Workspace name must be at most 80 characters.");
        let err = entity_name("workspace_name", " ").unwrap_err();
        assert_eq!(err.message, "Workspace name is required.");
    }

    #[test]
    fn collect_returns_every_failure() {
        let results = vec![
            Ok(()),
            email("nope").map(drop),
            password("short"),
            person_name("Ada").map(drop),
        ];

        let Err(AppError::Validation(errors)) = collect(results) else {
            panic!("expected a validation error");
        };

        let fields: Vec<&str> = errors.iter().map(|e| e.field.as_str()).collect();
        assert_eq!(fields, ["email", "password"]);
    }

    #[test]
    fn collect_passes_when_everything_is_valid() {
        assert!(collect(vec![Ok(()), Ok(())]).is_ok());
        assert!(collect(Vec::new()).is_ok());
    }
}
