use axum::{
    body::Bytes,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;
use std::borrow::Cow;

use crate::error::AppError;

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";
const NOT_BUILT: &str = "Web UI not built. Run `pnpm --dir web build`.";

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
struct WebAssets;

pub async fn serve(uri: Uri) -> Response {
    respond::<WebAssets>(uri.path())
}

fn respond<A: RustEmbed>(request_path: &str) -> Response {
    let path = request_path.trim_start_matches('/');
    if path == "api" || path.starts_with("api/") {
        return AppError::NotFound.into_response();
    }
    if let Some(file) = A::get(path) {
        let cache = if path.starts_with("assets/") {
            IMMUTABLE
        } else {
            NO_CACHE
        };
        return asset(path, file.data, cache);
    }
    match A::get("index.html") {
        Some(index) => asset("index.html", index.data, NO_CACHE),
        None => (StatusCode::NOT_FOUND, NOT_BUILT).into_response(),
    }
}

fn asset(name: &str, data: Cow<'static, [u8]>, cache: &'static str) -> Response {
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    let body = match data {
        Cow::Borrowed(bytes) => Bytes::from_static(bytes),
        Cow::Owned(bytes) => Bytes::from(bytes),
    };
    (
        [
            (header::CONTENT_TYPE, mime.as_ref()),
            (header::CACHE_CONTROL, cache),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[derive(RustEmbed)]
    #[folder = "tests/fixtures/web"]
    struct Built;

    #[derive(RustEmbed)]
    #[folder = "tests/fixtures/web_no_index"]
    struct NotBuilt;

    async fn text(response: Response) -> String {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn header_value(response: &Response, name: header::HeaderName) -> &str {
        response.headers()[name].to_str().unwrap()
    }

    #[tokio::test]
    async fn hashed_assets_are_cached_immutably() {
        let response = respond::<Built>("/assets/app.abc123.js");

        assert_eq!(response.status(), StatusCode::OK);
        assert!(header_value(&response, header::CONTENT_TYPE).contains("javascript"));
        assert_eq!(header_value(&response, header::CACHE_CONTROL), IMMUTABLE);
        assert_eq!(text(response).await, "console.log(\"fixture\");\n");
    }

    #[test]
    fn other_files_are_served_uncached_with_their_mime_type() {
        let response = respond::<Built>("/favicon.svg");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            header_value(&response, header::CONTENT_TYPE),
            "image/svg+xml"
        );
        assert_eq!(header_value(&response, header::CACHE_CONTROL), NO_CACHE);
    }

    #[tokio::test]
    async fn client_routes_fall_back_to_index_html() {
        for path in ["/", "/models/123/settings", "/apiary"] {
            let response = respond::<Built>(path);

            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(
                header_value(&response, header::CONTENT_TYPE),
                "text/html",
                "{path}"
            );
            assert_eq!(
                header_value(&response, header::CACHE_CONTROL),
                NO_CACHE,
                "{path}"
            );
            assert!(text(response).await.contains("OpenPlan fixture"), "{path}");
        }
    }

    #[tokio::test]
    async fn api_paths_never_fall_back_to_index_html() {
        for path in ["/api", "/api/v1/nope"] {
            let response = respond::<Built>(path);

            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(
                header_value(&response, header::CONTENT_TYPE),
                "application/problem+json",
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn missing_index_explains_how_to_build_the_web_ui() {
        let response = respond::<NotBuilt>("/models");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(text(response).await, NOT_BUILT);
    }
}
