use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use openplan_engine::{EngineError, FormulaError};
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
    #[error("server busy, retry in {retry_after_secs}s")]
    Busy { retry_after_secs: u64 },
    #[error("not found")]
    NotFound,
    #[error("method not allowed")]
    MethodNotAllowed,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unsupported media type")]
    UnsupportedMediaType,
    #[error("payload too large")]
    PayloadTooLarge,
    #[error("conflict ({code}): {detail}")]
    Conflict { code: &'static str, detail: String },
    #[error("not found ({code}): {detail}")]
    CodedNotFound { code: &'static str, detail: String },
    #[error("validation failed")]
    Validation(Vec<FieldError>),
    /// A request body refers to something that does not exist. Only a path parameter that names
    /// nothing is a 404; this one is `structure.invalid` and names the fields.
    #[error("the request refers to something that does not exist")]
    MissingReferences(Vec<FieldError>),
    /// A request the server understood and refuses: `code` tells why, and `errors` which parts of
    /// the request are wrong.
    #[error("unprocessable ({code}): {detail}")]
    Unprocessable {
        code: &'static str,
        detail: String,
        errors: Vec<FieldError>,
    },
    #[error("engine rejected the change: {0}")]
    Engine(#[from] EngineError),
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

/// A problem found in a formula, located by the byte positions of the part it concerns.
#[derive(Serialize, ToSchema)]
pub struct FormulaProblem {
    /// A stable code such as `formula.unknown_name`.
    code: &'static str,
    message: String,
    /// Where the problem starts, in bytes from the start of the formula.
    start: usize,
    /// Where the problem ends, in bytes from the start of the formula.
    end: usize,
    /// What to write instead, such as the name that was probably meant.
    suggestion: Option<String>,
}

impl From<&FormulaError> for FormulaProblem {
    fn from(error: &FormulaError) -> Self {
        FormulaProblem {
            code: error.code,
            message: error.message.clone(),
            start: error.start,
            end: error.end,
            suggestion: error.suggestion.clone(),
        }
    }
}

/// The body of every error response, served as `application/problem+json`.
#[derive(Serialize, ToSchema)]
pub struct Problem {
    /// Always `about:blank`.
    #[serde(rename = "type")]
    kind: &'static str,
    /// The reason phrase of the HTTP status.
    title: &'static str,
    status: u16,
    /// A stable code such as `auth.csrf` that clients can match on.
    code: &'static str,
    /// A sentence for people.
    detail: String,
    /// What is wrong with each field; only on 422 responses.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(nullable = false)]
    errors: Option<Vec<FieldError>>,
    /// What is wrong with a formula, with where; only on formula errors, which also list the
    /// problems in `errors`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(nullable = false)]
    formula_errors: Option<Vec<FormulaProblem>>,
}

/// Makes the message of an engine error, which is written without a capital or a full stop, read
/// as a sentence.
fn sentence(message: &str) -> String {
    let mut chars = message.trim().chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut sentence: String = first.to_uppercase().chain(chars).collect();
    if !sentence.ends_with(['.', '!', '?']) {
        sentence.push('.');
    }
    sentence
}

/// The status, code and sentence of the response to an engine error.
fn engine_problem(error: &EngineError) -> (StatusCode, &'static str, String) {
    let status = match error {
        EngineError::NotFound { .. } => StatusCode::NOT_FOUND,
        EngineError::NameTaken { .. } | EngineError::InUse { .. } => StatusCode::CONFLICT,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    let code = match error {
        EngineError::NotFound { .. } => "not_found",
        other => other.code(),
    };
    let detail = match error {
        EngineError::Formula(problems) => match problems.as_slice() {
            [problem] => sentence(&problem.message),
            [] => "The formula is not valid.".to_string(),
            _ => format!("The formula has {} problems.", problems.len()),
        },
        other => sentence(&other.to_string()),
    };
    (status, code, detail)
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut retry_after = None;
        let mut errors = None;
        let mut formula_errors = None;
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
            AppError::Busy { retry_after_secs } => {
                retry_after = Some(retry_after_secs);
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "server.busy",
                    "The server is busy. Try again in a moment.".to_string(),
                )
            }
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
            AppError::BadRequest(detail) => (StatusCode::BAD_REQUEST, "bad_request", detail),
            AppError::UnsupportedMediaType => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "Send the request body as application/json.".to_string(),
            ),
            AppError::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "The request body is too large.".to_string(),
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
            AppError::MissingReferences(field_errors) => {
                let detail = match field_errors.as_slice() {
                    [only] => only.message.clone(),
                    _ => "Some of the things the request refers to do not exist.".to_string(),
                };
                errors = Some(field_errors);
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "structure.invalid",
                    detail,
                )
            }
            AppError::Unprocessable {
                code,
                detail,
                errors: field_errors,
            } => {
                errors = Some(field_errors);
                (StatusCode::UNPROCESSABLE_ENTITY, code, detail)
            }
            AppError::Engine(error) => {
                match &error {
                    EngineError::Formula(problems) => {
                        errors = Some(
                            problems
                                .iter()
                                .map(|problem| FieldError {
                                    field: "formula".into(),
                                    message: format!(
                                        "{}-{}: {}",
                                        problem.start, problem.end, problem.message
                                    ),
                                })
                                .collect(),
                        );
                        formula_errors = Some(problems.iter().map(FormulaProblem::from).collect());
                    }
                    EngineError::InvalidValue { cells } => {
                        errors = Some(
                            cells
                                .iter()
                                .map(|cell| FieldError {
                                    field: format!("cells[{}]", cell.index),
                                    message: cell.message.clone(),
                                })
                                .collect(),
                        );
                    }
                    _ => {}
                }
                engine_problem(&error)
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
            formula_errors,
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
    use openplan_engine::{CellIssue, EngineError, FormulaError};
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
    async fn unprocessable_requests_have_their_own_code_detail_and_fields() {
        let response = AppError::Unprocessable {
            code: "cells.invalid_value",
            detail: "1 edit has an invalid value.".into(),
            errors: vec![FieldError {
                field: "edits[4]".into(),
                message: "Expected a number.".into(),
            }],
        }
        .into_response();

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let json = body_json(response).await;
        assert_eq!(json["code"], "cells.invalid_value");
        assert_eq!(json["detail"], "1 edit has an invalid value.");
        assert_eq!(json["errors"][0]["field"], "edits[4]");
        assert_eq!(json["errors"][0]["message"], "Expected a number.");
    }

    #[tokio::test]
    async fn missing_references_are_structure_invalid_and_name_their_fields() {
        let one = AppError::MissingReferences(vec![FieldError {
            field: "format.list".into(),
            message: "The list does not exist.".into(),
        }])
        .into_response();
        assert_eq!(one.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let json = body_json(one).await;
        assert_eq!(json["code"], "structure.invalid");
        assert_eq!(json["detail"], "The list does not exist.");
        assert_eq!(json["errors"][0]["field"], "format.list");

        let two = AppError::MissingReferences(vec![
            FieldError {
                field: "axes[0].list".into(),
                message: "The list does not exist.".into(),
            },
            FieldError {
                field: "axes[1].subset".into(),
                message: "The subset does not exist.".into(),
            },
        ])
        .into_response();
        let json = body_json(two).await;
        assert_eq!(
            json["detail"],
            "Some of the things the request refers to do not exist."
        );
        assert_eq!(json["errors"].as_array().unwrap().len(), 2);
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
    async fn busy_is_503_and_says_when_to_try_again() {
        let response = AppError::Busy {
            retry_after_secs: 2,
        }
        .into_response();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::RETRY_AFTER], "2");
        let json = body_json(response).await;
        assert_eq!(json["code"], "server.busy");
        assert_eq!(json["detail"], "The server is busy. Try again in a moment.");
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
    async fn request_body_errors_have_their_own_status_and_code() {
        let bad_request = AppError::BadRequest("The request body is not valid JSON.".into());
        let response = bad_request.into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let json = body_json(response).await;
        assert_eq!(json["code"], "bad_request");
        assert_eq!(json["detail"], "The request body is not valid JSON.");

        let response = AppError::UnsupportedMediaType.into_response();
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(body_json(response).await["code"], "unsupported_media_type");

        let response = AppError::PayloadTooLarge.into_response();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(body_json(response).await["code"], "payload_too_large");
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

    fn engine_response(error: EngineError) -> Response {
        AppError::Engine(error).into_response()
    }

    #[tokio::test]
    async fn formula_errors_are_422_with_every_error_and_their_spans() {
        let response = engine_response(EngineError::Formula(vec![
            FormulaError {
                code: "formula.unknown_name",
                message: "Unknown name 'Revnue'".to_string(),
                start: 4,
                end: 10,
                suggestion: Some("Revenue".to_string()),
            },
            FormulaError {
                code: "formula.arity",
                message: "SUM takes 1 argument".to_string(),
                start: 12,
                end: 20,
                suggestion: None,
            },
        ]));

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let json = body_json(response).await;
        assert_eq!(json["code"], "formula.unknown_name");
        assert_eq!(json["status"], 422);
        assert_eq!(
            json["errors"],
            serde_json::json!([
                { "field": "formula", "message": "4-10: Unknown name 'Revnue'" },
                { "field": "formula", "message": "12-20: SUM takes 1 argument" },
            ])
        );
        assert_eq!(
            json["formula_errors"],
            serde_json::json!([
                {
                    "code": "formula.unknown_name",
                    "message": "Unknown name 'Revnue'",
                    "start": 4,
                    "end": 10,
                    "suggestion": "Revenue",
                },
                {
                    "code": "formula.arity",
                    "message": "SUM takes 1 argument",
                    "start": 12,
                    "end": 20,
                    "suggestion": null,
                },
            ])
        );
        assert!(json["detail"].as_str().unwrap().contains("2 problems"));
    }

    #[tokio::test]
    async fn one_formula_error_is_the_detail() {
        let json = body_json(engine_response(EngineError::Formula(vec![FormulaError {
            code: "formula.syntax",
            message: "Expected a value".to_string(),
            start: 3,
            end: 4,
            suggestion: None,
        }])))
        .await;

        assert_eq!(json["code"], "formula.syntax");
        assert_eq!(json["detail"], "Expected a value.");
    }

    #[tokio::test]
    async fn invalid_cells_are_listed_by_position() {
        let response = engine_response(EngineError::InvalidValue {
            cells: vec![
                CellIssue {
                    index: 0,
                    message: "Enter a number".to_string(),
                },
                CellIssue {
                    index: 3,
                    message: "Enter a date".to_string(),
                },
            ],
        });

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let json = body_json(response).await;
        assert_eq!(json["code"], "cells.invalid_value");
        assert_eq!(
            json["errors"],
            serde_json::json!([
                { "field": "cells[0]", "message": "Enter a number" },
                { "field": "cells[3]", "message": "Enter a date" },
            ])
        );
        assert!(json.get("formula_errors").is_none());
    }

    #[tokio::test]
    async fn other_engine_errors_have_their_status_and_code() {
        let cases = [
            (
                EngineError::NotFound {
                    what: "list",
                    id: "abc".to_string(),
                },
                StatusCode::NOT_FOUND,
                "not_found",
                "List not found: abc.",
            ),
            (
                EngineError::NameTaken {
                    what: "module",
                    name: "Revenue".to_string(),
                },
                StatusCode::CONFLICT,
                "structure.name_taken",
                "Module name already in use: Revenue.",
            ),
            (
                EngineError::Invalid {
                    message: "years must be between 1 and 20".to_string(),
                },
                StatusCode::UNPROCESSABLE_ENTITY,
                "structure.invalid",
                "Years must be between 1 and 20.",
            ),
            (
                EngineError::InUse {
                    message: "The list is used by a module.".to_string(),
                },
                StatusCode::CONFLICT,
                "structure.in_use",
                "The list is used by a module.",
            ),
            (
                EngineError::NotInput {
                    line_item: "Margin".to_string(),
                },
                StatusCode::UNPROCESSABLE_ENTITY,
                "cells.not_input",
                "Line item Margin is calculated and cannot be edited.",
            ),
            (
                EngineError::InvalidCoordinate {
                    message: "Cell 2: no such period".to_string(),
                    index: None,
                },
                StatusCode::UNPROCESSABLE_ENTITY,
                "cells.invalid_coordinate",
                "Cell 2: no such period.",
            ),
        ];
        for (error, status, code, detail) in cases {
            let response = engine_response(error);

            assert_eq!(response.status(), status, "{code}");
            let json = body_json(response).await;
            assert_eq!(json["code"], code);
            assert_eq!(json["detail"], detail);
            assert!(json.get("errors").is_none(), "{code}");
            assert!(json.get("formula_errors").is_none(), "{code}");
        }
    }
}
