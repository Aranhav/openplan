use std::error::Error as _;

use axum::{
    Json,
    extract::{
        FromRequest, FromRequestParts, Path, Query, Request,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{StatusCode, request::Parts},
};
use serde::{Deserialize, Deserializer, de::DeserializeOwned};

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

/// Reads a field that may also be sent as `null`: absent is `None`, `null` is `Some(None)` and a
/// value is `Some(Some(value))`. Use it as `#[serde(default, deserialize_with = "nullable")]`.
pub fn nullable<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A path parameter whose rejections are `application/problem+json` 404s: a
/// parameter that does not parse names no resource.
pub struct ApiPath<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiPath<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Send,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        let Path(value) = Path::<T>::from_request_parts(parts, state)
            .await
            .map_err(|_| AppError::NotFound)?;
        Ok(ApiPath(value))
    }
}

/// A query string whose rejections are `application/problem+json` 422s that name the missing
/// field.
pub struct ApiQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        let Query(value) = Query::<T>::from_request_parts(parts, state).await?;
        Ok(ApiQuery(value))
    }
}

impl From<QueryRejection> for AppError {
    fn from(rejection: QueryRejection) -> Self {
        let message = rejection
            .source()
            .map(ToString::to_string)
            .unwrap_or_default();
        AppError::Validation(vec![match missing_field(&message) {
            Some(name) => FieldError {
                field: name.to_string(),
                message: format!("{} is required.", validate::label(name)),
            },
            None => FieldError {
                field: "query".to_string(),
                message: "The query string is invalid.".to_string(),
            },
        }])
    }
}

/// The name in a deserialization message such as "missing field `password`".
fn missing_field(message: &str) -> Option<&str> {
    message
        .strip_prefix("missing field `")
        .and_then(|rest| rest.split_once('`'))
        .map(|(name, _)| name)
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
    match (path, missing_field(detail)) {
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
        routing::{get, post},
    };
    use serde::Deserialize;
    use serde_json::Value;
    use tower::ServiceExt;
    use uuid::Uuid;

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

    async fn get_path(uri: &str) -> (StatusCode, Option<String>, String) {
        let router = Router::new().route(
            "/{id}",
            get(|ApiPath(id): ApiPath<Uuid>| async move { id.to_string() }),
        );
        let response = router
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .map(|value| value.to_str().unwrap().to_string());
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            content_type,
            String::from_utf8(bytes.to_vec()).unwrap(),
        )
    }

    #[tokio::test]
    async fn well_formed_path_parameter_is_extracted() {
        let id = Uuid::now_v7();

        let (status, _, body) = get_path(&format!("/{id}")).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, id.to_string());
    }

    #[tokio::test]
    async fn malformed_path_parameter_is_a_problem_not_found() {
        let (status, content_type, body) = get_path("/not-a-uuid").await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(content_type.unwrap(), "application/problem+json");
        let json: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["code"], "not_found");
    }

    #[derive(Deserialize)]
    struct Search {
        line_item_id: Uuid,
        #[serde(default)]
        prefix: String,
    }

    async fn get_query(uri: &str) -> (StatusCode, Value) {
        let router = Router::new().route(
            "/",
            get(|ApiQuery(search): ApiQuery<Search>| async move {
                format!("{}:{}", search.line_item_id, search.prefix)
            }),
        );
        let response = router
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8(bytes.to_vec()).unwrap())),
        )
    }

    #[tokio::test]
    async fn well_formed_query_is_extracted() {
        let id = Uuid::now_v7();

        let (status, body) = get_query(&format!("/?line_item_id={id}&prefix=Re%20v")).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, Value::String(format!("{id}:Re v")));
    }

    #[tokio::test]
    async fn missing_query_field_names_the_field() {
        let (status, json) = get_query("/?prefix=a").await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(json["code"], "validation");
        assert_eq!(json["errors"][0]["field"], "line_item_id");
        assert_eq!(json["errors"][0]["message"], "Line item id is required.");
    }

    #[tokio::test]
    async fn ill_typed_query_falls_back_to_the_query_field() {
        let (status, json) = get_query("/?line_item_id=nope").await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(json["errors"][0]["field"], "query");
        assert_eq!(json["errors"][0]["message"], "The query string is invalid.");
    }
}
