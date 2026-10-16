use std::{error::Error as _, fmt, marker::PhantomData};

use axum::{
    Json,
    body::Bytes,
    extract::{
        FromRequest, FromRequestParts, Path, Query, Request,
        rejection::{BytesRejection, JsonRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header::CONTENT_TYPE, request::Parts},
};
use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{DeserializeOwned, IgnoredAny, SeqAccess, Visitor},
};

use crate::{
    error::{AppError, FieldError},
    validate,
};

/// A JSON request body whose rejections are `application/problem+json`
/// instead of axum's plain-text defaults. A text in it with the NUL character, which the
/// database cannot store, is a 422 that names the field; for a body of more than 2 MiB, which is
/// scanned and not parsed to find it, the field is `body`.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, AppError> {
        if !has_json_content_type(req.headers()) {
            return Err(AppError::UnsupportedMediaType);
        }
        let body = Bytes::from_request(req, state).await?;
        if let Some(field) = nul_in_json(&body) {
            return Err(nul_error(&field));
        }
        let Json(value) = Json::<T>::from_bytes(&body)?;
        Ok(ApiJson(value))
    }
}

/// Whether the request says its body is JSON: `application/json` or a `+json` type, with any
/// parameters.
fn has_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let essence = value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            essence == "application/json"
                || (essence.starts_with("application/") && essence.ends_with("+json"))
        })
}

fn nul_error(field: &str) -> AppError {
    AppError::Validation(vec![FieldError {
        field: field.to_string(),
        message: "Text can't contain the NUL character.".to_string(),
    }])
}

/// How large a body may be for the field with the NUL character to be named by its path. The
/// path is found by parsing the body, which takes up to sixteen times its size in memory (32
/// bytes for each `0,`), so a larger body is only scanned and the field is `body`.
const NAMED_PATH_LIMIT: usize = 2 << 20;

/// The field of a JSON body whose text has the NUL character, or `body` when it is not a field
/// of an object or the body is too large to tell. Nothing for a body that is not JSON, which the
/// parser refuses, unless it is too large to tell.
fn nul_in_json(body: &[u8]) -> Option<String> {
    if !has_nul_escape(body) {
        return None;
    }
    if body.len() > NAMED_PATH_LIMIT {
        return Some("body".to_string());
    }
    let document: serde_json::Value = serde_json::from_slice(body).ok()?;
    nul_path(&document, "").map(|path| if path.is_empty() { "body".into() } else { path })
}

/// Whether a JSON document spells the NUL character, `\u0000`, in a text. It reads the bytes
/// once and keeps nothing: inside a text a backslash takes the byte after it along, so the second
/// backslash of `\\u0000` does not start the escape.
fn has_nul_escape(body: &[u8]) -> bool {
    let mut in_text = false;
    let mut bytes = body.iter().enumerate();
    while let Some((at, byte)) = bytes.next() {
        match byte {
            b'"' => in_text = !in_text,
            b'\\' if in_text => {
                if body[at + 1..].starts_with(b"u0000") {
                    return true;
                }
                bytes.next();
            }
            _ => {}
        }
    }
    false
}

/// The path of the first text in `value` with the NUL character, `path` being that of `value`.
/// A key that has it is reported as the object it is in.
fn nul_path(value: &serde_json::Value, path: &str) -> Option<String> {
    use serde_json::Value;
    match value {
        Value::String(text) => text.contains('\0').then(|| path.to_string()),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .find_map(|(index, item)| nul_path(item, &format!("{path}[{index}]"))),
        Value::Object(fields) => fields.iter().find_map(|(key, field)| {
            if key.contains('\0') {
                return Some(path.to_string());
            }
            let at = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            nul_path(field, &at)
        }),
        _ => None,
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

/// A list in a JSON body of which at most `N` elements are read into memory. Whatever comes
/// after them is read as far as JSON goes, to find the end of the list, and counted, so that the
/// handler can refuse a list that is too long without having made room for all of it. A request
/// that is a few megabytes of `"",` takes 10 times that when it is read into a list of texts,
/// and twice that while the list grows.
pub struct Capped<T, const N: usize> {
    items: Vec<T>,
    total: usize,
}

impl<T, const N: usize> Capped<T, N> {
    /// Whether the list had more than `N` elements, of which `N` were kept.
    pub fn is_over(&self) -> bool {
        self.total > N
    }

    /// The elements that were kept, the first `N`.
    pub fn into_vec(self) -> Vec<T> {
        self.items
    }
}

impl<T, const N: usize> Default for Capped<T, N> {
    fn default() -> Self {
        Capped {
            items: Vec::new(),
            total: 0,
        }
    }
}

/// A list of `items`, all of them counted, so that one longer than `N` is over.
impl<T, const N: usize> From<Vec<T>> for Capped<T, N> {
    fn from(items: Vec<T>) -> Self {
        let total = items.len();
        Capped { items, total }
    }
}

/// The elements that were kept, as a list.
impl<T: Serialize, const N: usize> Serialize for Capped<T, N> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.items.serialize(serializer)
    }
}

impl<'de, T: Deserialize<'de>, const N: usize> Deserialize<'de> for Capped<T, N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Elements<T, const N: usize>(PhantomData<T>);

        impl<'de, T: Deserialize<'de>, const N: usize> Visitor<'de> for Elements<T, N> {
            type Value = Capped<T, N>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a list")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut list: A) -> Result<Capped<T, N>, A::Error> {
                let mut items = Vec::new();
                while items.len() < N {
                    match list.next_element()? {
                        Some(item) => items.push(item),
                        None => {
                            let total = items.len();
                            return Ok(Capped { items, total });
                        }
                    }
                }
                let mut total = N;
                while list.next_element::<IgnoredAny>()?.is_some() {
                    total += 1;
                }
                Ok(Capped { items, total })
            }
        }

        deserializer.deserialize_seq(Elements(PhantomData))
    }
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
/// field. A value with the NUL character, which the database cannot store, is a 422 too.
pub struct ApiQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        if let Some(field) = parts.uri.query().and_then(nul_in_query) {
            return Err(nul_error(&field));
        }
        let Query(value) = Query::<T>::from_request_parts(parts, state).await?;
        Ok(ApiQuery(value))
    }
}

/// The name of the first parameter of a query string whose name or value has the NUL character
/// percent-encoded, or `query` when the name cannot be told.
fn nul_in_query(query: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (decodes_to_nul(name) || decodes_to_nul(value)).then(|| {
            if name.is_empty() || name.contains(['%', '+']) {
                "query".to_string()
            } else {
                name.to_string()
            }
        })
    })
}

/// Whether the percent-encoded `text` decodes to a text with the NUL character. `%2500` is a
/// percent sign and two zeros.
fn decodes_to_nul(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%'
            && let Some(digits) = bytes.get(at + 1..at + 3)
            && digits.iter().all(u8::is_ascii_hexdigit)
        {
            if digits == b"00" {
                return true;
            }
            at += 3;
        } else {
            at += 1;
        }
    }
    false
}

impl From<BytesRejection> for AppError {
    fn from(rejection: BytesRejection) -> Self {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::PayloadTooLarge
        } else {
            AppError::BadRequest("The request body could not be read.".into())
        }
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
    async fn text_with_the_nul_character_is_refused_before_it_is_read() {
        let (status, json) = send(
            Some("application/json"),
            r#"{"name":"a\u0000b","inner":{"count":"not a number"}}"#,
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(json["code"], "validation");
        assert_eq!(json["errors"][0]["field"], "name");
        assert_eq!(
            json["errors"][0]["message"],
            "Text can't contain the NUL character."
        );
    }

    #[test]
    fn a_nul_escape_is_found_unless_its_backslash_is_escaped() {
        let found = |body: &str| has_nul_escape(body.as_bytes());

        assert!(found(r#"{"a":"x\u0000y"}"#));
        assert!(!found(r#"{"a":"x\\u0000y"}"#));
        assert!(found(r#"{"a":"x\\\u0000y"}"#));
        assert!(!found(r#"{"a":"x\u0001y"}"#));
        assert!(!found(r#"{"a":"x"}"#));
    }

    #[test]
    fn a_nul_escape_is_one_in_a_text_whatever_the_quotes_around_it() {
        let found = |body: &str| has_nul_escape(body.as_bytes());

        assert!(found(r#"{"a":"\"","b":"\u0000"}"#));
        assert!(found(r#"{"a":"\\","b":"\u0000"}"#));
        assert!(!found(r#"{"a":"\\","b":"\\u0000"}"#));
        assert!(!found(r#"{"a":"\"\\u0000"}"#));
        assert!(!found(r#"["a"] \u0000"#), "outside of a text");
        assert!(found(r#"["\u00000"]"#), "a NUL and then a zero");
        assert!(!found("\"\\"), "a backslash at the end");
    }

    #[test]
    fn the_text_with_a_nul_is_named_by_its_path() {
        let field = |body: &str| nul_in_json(body.as_bytes());

        assert_eq!(field(r#"{"notes":"a\u0000"}"#).unwrap(), "notes");
        assert_eq!(
            field(r#"{"edits":[{},{"value":{"v":"\u0000"}}]}"#).unwrap(),
            "edits[1].value.v"
        );
        assert_eq!(field(r#"{"a":{"b\u0000":1}}"#).unwrap(), "a");
        assert_eq!(field(r#"{"b\u0000":1}"#).unwrap(), "body");
        assert_eq!(field(r#""\u0000""#).unwrap(), "body");
        assert_eq!(field(r#"{"notes":"\\u0000"}"#), None);
        assert_eq!(field(r#"{"notes":"a\u0000""#), None, "not JSON");
        assert_eq!(field(r#"{"notes":"fine"}"#), None);
    }

    #[test]
    fn a_large_body_is_scanned_and_not_parsed_so_its_field_is_the_body() {
        let padding = "0,".repeat(NAMED_PATH_LIMIT / 2);
        let with_nul = format!(r#"{{"notes":"a\u0000","padding":[{padding}0]}}"#);
        let without = format!(r#"{{"notes":"a","padding":[{padding}0]}}"#);
        assert!(with_nul.len() > NAMED_PATH_LIMIT);

        assert_eq!(nul_in_json(with_nul.as_bytes()).unwrap(), "body");
        assert_eq!(nul_in_json(without.as_bytes()), None);
        let small = format!(
            r#"{{"notes":"a\u0000","padding":[{}0]}}"#,
            "0,".repeat(1000)
        );
        assert_eq!(nul_in_json(small.as_bytes()).unwrap(), "notes");
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
    async fn a_query_value_with_the_nul_character_is_refused() {
        let id = Uuid::now_v7();

        let (status, json) = get_query(&format!("/?line_item_id={id}&prefix=a%00b")).await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(json["code"], "validation");
        assert_eq!(json["errors"][0]["field"], "prefix");
        assert_eq!(
            json["errors"][0]["message"],
            "Text can't contain the NUL character."
        );
    }

    #[test]
    fn the_parameter_with_an_encoded_nul_is_named() {
        assert_eq!(nul_in_query("a=1&cell_key=%00").unwrap(), "cell_key");
        assert_eq!(nul_in_query("a=x%2Fy%00").unwrap(), "a");
        assert_eq!(nul_in_query("%00=1").unwrap(), "query");
        assert_eq!(nul_in_query("a=1&%00").unwrap(), "query");
        assert_eq!(
            nul_in_query("a=%2500"),
            None,
            "a percent sign and two zeros"
        );
        assert_eq!(nul_in_query("a=%25%00").unwrap(), "a");
        assert_eq!(nul_in_query("a=%0"), None);
        assert_eq!(nul_in_query("a=%zz00"), None);
        assert_eq!(nul_in_query("a=100%"), None);
        assert_eq!(nul_in_query("a=1&b=%20"), None);
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

    #[test]
    fn a_capped_list_keeps_what_fits_and_counts_the_rest() {
        let list: Capped<u32, 3> = serde_json::from_str("[1,2,3,4,5]").unwrap();
        assert!(list.is_over());
        assert_eq!(list.into_vec(), [1, 2, 3]);

        let list: Capped<u32, 3> = serde_json::from_str("[1,2,3]").unwrap();
        assert!(!list.is_over());
        assert_eq!(list.into_vec(), [1, 2, 3]);

        let list: Capped<u32, 3> = serde_json::from_str("[]").unwrap();
        assert!(!list.is_over());
        assert!(list.into_vec().is_empty());
    }

    #[test]
    fn a_capped_list_reads_the_elements_it_does_not_keep_only_as_far_as_json_goes() {
        // Elements past the cap are not read into the type, so they need not fit it ...
        let list: Capped<u32, 1> = serde_json::from_str(r#"[1,"two",{"three":3}]"#).unwrap();
        assert!(list.is_over());
        assert_eq!(list.into_vec(), [1]);
        // ... but they are still JSON, and a kept one has to fit.
        assert!(serde_json::from_str::<Capped<u32, 1>>("[1,2,").is_err());
        assert!(serde_json::from_str::<Capped<u32, 2>>(r#"[1,"two"]"#).is_err());
        assert!(serde_json::from_str::<Capped<u32, 1>>("5").is_err());
    }
}
