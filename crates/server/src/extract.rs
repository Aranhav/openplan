use std::error::Error as _;

use axum::{
    Json,
    extract::{FromRequest, Request, rejection::JsonRejection},
    http::StatusCode,
};
use serde::de::DeserializeOwned;

use crate::{
    error::{AppError, FieldError},
    validate,
};

/// A JSON request body whose rejections are `application/problem+json`
/// instead of axum's plain-text defaults.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, AppError> {
        let Json(value) = Json::<T>::from_request(req, state).await?;
        Ok(ApiJson(value))
    }
}

impl From<JsonRejection> for AppError {
    fn from(rejection: JsonRejection) -> Self {
        match rejection {
            JsonRejection::JsonDataError(err) => {
                let message = err.source().map(ToString::to_string).unwrap_or_default();
                AppError::Validation(vec![data_error_field(&message)])
            }
            JsonRejection::JsonSyntaxError(_) => {
                AppError::BadRequest("The request body is not valid JSON.".into())
            }
            JsonRejection::MissingJsonContentType(_) => AppError::UnsupportedMediaType,
            other if other.status() == StatusCode::PAYLOAD_TOO_LARGE => AppError::PayloadTooLarge,
            _ => AppError::BadRequest("The request body could not be read.".into()),
        }
    }
}

/// Builds a field error from the message of a failed JSON deserialization, such
/// as "email: invalid type: integer `5`, expected a string at line 1 column 12"
/// or "missing field `password` at line 1 column 15". Falls back to the field
/// `body` when the message names no field.
fn data_error_field(message: &str) -> FieldError {
    let (path, detail) = match message.split_once(": ") {
        Some((path, detail)) if is_field_path(path) => (Some(path), detail),
        _ => (None, message),
    };
    let missing = detail
        .strip_prefix("missing field `")
        .and_then(|rest| rest.split_once('`'))
        .map(|(name, _)| name);
    match (path, missing) {
        (path, Some(name)) => {
            let field = path.map_or_else(|| name.to_string(), |path| format!("{path}.{name}"));
            let message = format!("{} is required.", validate::label(&field));
            FieldError { field, message }
        }
        (Some(path), None) => FieldError {
            field: path.to_string(),
            message: format!("{} is invalid.", validate::label(path)),
        },
        (None, None) => FieldError {
            field: "body".to_string(),
            message: "The request body is invalid.".to_string(),
        },
    }
}

fn is_field_path(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '[' | ']'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, header},
        routing::post,
    };
    use serde::Deserialize;
    use serde_json::Value;
    use tower::ServiceExt;

    #[derive(Deserialize)]
    struct Sample {
        name: String,
        inner: Inner,
    }

    #[derive(Deserialize)]
    struct Inner {
        count: u32,
    }

    async fn send(content_type: Option<&str>, body: impl Into<Body>) -> (StatusCode, Value) {
        let router = Router::new().route(
            "/",
            post(|ApiJson(sample): ApiJson<Sample>| async move {
                format!("{}{}", sample.name, sample.inner.count)
            }),
        );
        let mut request = Request::post("/");
        if let Some(content_type) = content_type {
            request = request.header(header::CONTENT_TYPE, content_type);
        }
        let response = router
            .oneshot(request.body(body.into()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        if status != StatusCode::OK {
            assert_eq!(content_type.unwrap(), "application/problem+json");
        }
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn field_and_message(body: &str) -> (String, String) {
        let (status, json) = send(Some("application/json"), body.to_string()).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let error = &json["errors"][0];
        (
            error["field"].as_str().unwrap().to_string(),
            error["message"].as_str().unwrap().to_string(),
        )
    }

    #[tokio::test]
    async fn valid_body_is_extracted() {
        let (status, _) = send(
            Some("application/json"),
            r#"{"name":"a","inner":{"count":1}}"#,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn missing_field_names_the_field() {
        let (field, message) = field_and_message(r#"{"inner":{"count":1}}"#).await;

        assert_eq!(field, "name");
        assert_eq!(message, "Name is required.");
    }

    #[tokio::test]
    async fn missing_nested_field_names_the_full_path() {
        let (field, _) = field_and_message(r#"{"name":"a","inner":{}}"#).await;

        assert_eq!(field, "inner.count");
    }

    #[tokio::test]
    async fn ill_typed_field_names_the_field() {
        let (field, message) = field_and_message(r#"{"name":5,"inner":{"count":1}}"#).await;
        assert_eq!(field, "name");
        assert_eq!(message, "Name is invalid.");

        let (field, _) = field_and_message(r#"{"name":"a","inner":{"count":-1}}"#).await;
        assert_eq!(field, "inner.count");
    }

    #[tokio::test]
    async fn body_of_the_wrong_shape_falls_back_to_the_body_field() {
        for body in ["[]", "null", "5", r#""text""#] {
            let (field, message) = field_and_message(body).await;
            assert_eq!(field, "body", "{body}");
            assert_eq!(message, "The request body is invalid.");
        }
    }

    #[tokio::test]
    async fn invalid_syntax_is_a_bad_request() {
        let (status, json) = send(Some("application/json"), "{oops").await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["code"], "bad_request");
        assert_eq!(json["detail"], "The request body is not valid JSON.");
    }

    #[tokio::test]
    async fn other_content_types_are_unsupported() {
        for content_type in [None, Some("text/plain")] {
            let (status, json) = send(content_type, r#"{"name":"a"}"#).await;
            assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
            assert_eq!(json["code"], "unsupported_media_type");
        }
    }
}
