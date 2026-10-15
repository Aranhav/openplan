use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FieldError {
    pub field: String,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("authentication required")]
    Unauthenticated,
    #[error("invalid credentials")]
    InvalidCredentials,
    #[error("forbidden")]
    Forbidden,
    #[error("missing or invalid CSRF token")]
    Csrf,
    #[error("rate limited, retry in {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },
    #[error("not found")]
    NotFound,
    #[error("method not allowed")]
    MethodNotAllowed,
    #[error("conflict ({code}): {detail}")]
    Conflict { code: &'static str, detail: String },
    #[error("not found ({code}): {detail}")]
    CodedNotFound { code: &'static str, detail: String },
    #[error("validation failed")]
    Validation(Vec<FieldError>),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::RowNotFound => AppError::NotFound,
            other => AppError::Internal(other.into()),
        }
    }
}

impl From<FieldError> for AppError {
    fn from(err: FieldError) -> Self {
        AppError::Validation(vec![err])
    }
}

#[derive(Serialize)]
struct Problem {
    #[serde(rename = "type")]
    kind: &'static str,
    title: &'static str,
    status: u16,
    code: &'static str,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    errors: Option<Vec<FieldError>>,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut retry_after = None;
        let mut errors = None;
        let (status, code, detail) = match self {
            AppError::Unauthenticated => (
                StatusCode::UNAUTHORIZED,
                "auth.unauthenticated",
                "Sign in to continue.".to_string(),
            ),
            AppError::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                "auth.invalid_credentials",
                "Email or password is incorrect.".to_string(),
            ),
            AppError::Forbidden => (
                StatusCode::FORBIDDEN,
                "auth.forbidden",
                "You do not have permission to do that.".to_string(),
            ),
            AppError::Csrf => (
                StatusCode::FORBIDDEN,
                "auth.csrf",
                "The CSRF token is missing or invalid.".to_string(),
            ),
            AppError::RateLimited { retry_after_secs } => {
                retry_after = Some(retry_after_secs);
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    "auth.rate_limited",
                    "Too many attempts. Try again later.".to_string(),
                )
            }
            AppError::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "The requested resource was not found.".to_string(),
            ),
            AppError::MethodNotAllowed => (
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "The HTTP method is not allowed for this resource.".to_string(),
            ),
            AppError::Conflict { code, detail } => (StatusCode::CONFLICT, code, detail),
            AppError::CodedNotFound { code, detail } => (StatusCode::NOT_FOUND, code, detail),
            AppError::Validation(field_errors) => {
                errors = Some(field_errors);
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "validation",
                    "Some fields are invalid.".to_string(),
                )
            }
            AppError::Internal(err) => {
                tracing::error!("internal error: {err:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "Something went wrong.".to_string(),
                )
            }
        };

        let problem = Problem {
            kind: "about:blank",
            title: status.canonical_reason().unwrap_or("Error"),
            status: status.as_u16(),
            code,
            detail,
            errors,
        };
        let mut response = (
            status,
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/problem+json"),
            )],
            Json(problem),
        )
            .into_response();
        if let Some(secs) = retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, secs.into());
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::header};
    use serde_json::Value;

    async fn body_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn validation_error_lists_fields() {
        let response = AppError::Validation(vec![FieldError {
            field: "name".into(),
            message: "Name is required".into(),
        }])
        .into_response();

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let content_type = response.headers()[header::CONTENT_TYPE].to_str().unwrap();
        assert!(content_type.starts_with("application/problem+json"));
        let json = body_json(response).await;
        assert_eq!(json["type"], "about:blank");
        assert_eq!(json["status"], 422);
        assert_eq!(json["code"], "validation");
        assert_eq!(json["errors"][0]["field"], "name");
        assert_eq!(json["errors"][0]["message"], "Name is required");
    }

    #[tokio::test]
    async fn rate_limited_sets_retry_after() {
        let response = AppError::RateLimited {
            retry_after_secs: 30,
        }
        .into_response();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "30");
        assert_eq!(body_json(response).await["code"], "auth.rate_limited");
    }

    #[tokio::test]
    async fn errors_without_field_details_omit_errors_key() {
        let json = body_json(AppError::NotFound.into_response()).await;

        assert_eq!(json["code"], "not_found");
        assert_eq!(json["status"], 404);
        assert!(json.get("errors").is_none());
    }

    #[tokio::test]
    async fn coded_variants_use_their_code_and_detail() {
        let conflict = AppError::Conflict {
            code: "user.email_taken",
            detail: "Email is already registered.".into(),
        }
        .into_response();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        let json = body_json(conflict).await;
        assert_eq!(json["code"], "user.email_taken");
        assert_eq!(json["detail"], "Email is already registered.");

        let missing = AppError::CodedNotFound {
            code: "user.not_found",
            detail: "No such user.".into(),
        }
        .into_response();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(missing).await["code"], "user.not_found");
    }

    #[tokio::test]
    async fn internal_error_hides_details() {
        let response =
            AppError::Internal(anyhow::anyhow!("connection string leaked")).into_response();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let json = body_json(response).await;
        assert_eq!(json["code"], "internal");
        assert_eq!(json["detail"], "Something went wrong.");
    }

    #[test]
    fn single_field_error_converts_to_validation() {
        let err = AppError::from(FieldError {
            field: "email".into(),
            message: "Enter a valid email address.".into(),
        });

        let AppError::Validation(errors) = err else {
            panic!("expected a validation error");
        };
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].field, "email");
    }

    #[test]
    fn sqlx_row_not_found_maps_to_not_found() {
        assert!(matches!(
            AppError::from(sqlx::Error::RowNotFound),
            AppError::NotFound
        ));
        assert!(matches!(
            AppError::from(sqlx::Error::PoolTimedOut),
            AppError::Internal(_)
        ));
    }
}
