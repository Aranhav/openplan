// Each test crate compiles this module and uses only part of it.
#![allow(dead_code)]

use std::collections::HashMap;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use openplan_server::{
    app::{AppState, build_router},
    auth::{CSRF_COOKIE, CSRF_HEADER},
    config::Config,
};
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;

pub struct TestApp {
    pub router: Router,
    /// The state the router was built with, for tests that reach into it.
    pub state: AppState,
    pub db: PgPool,
    cookies: HashMap<String, String>,
}

enum Payload {
    Json(Option<Value>),
    Raw {
        content_type: Option<String>,
        body: String,
    },
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    /// The raw response body.
    pub text: String,
    /// The body parsed as JSON, or `Value::Null` when it is not JSON.
    pub json: Value,
}

impl TestApp {
    /// An app whose database is never reached, for routes that do not use it.
    pub fn without_database() -> TestApp {
        let db = PgPoolOptions::new()
            .connect_lazy("postgres://invalid")
            .expect("lazy pool does not connect");
        TestApp::new(db)
    }

    pub fn new(db: PgPool) -> TestApp {
        let config = Config::from_lookup(|name| match name {
            "DATABASE_URL" => Some("postgres://invalid".to_string()),
            "OPENPLAN_PUBLIC_URL" => Some("http://localhost:8080".to_string()),
            _ => None,
        })
        .expect("test config is valid");
        let state = AppState::new(db.clone(), config);
        TestApp {
            router: build_router(state.clone()),
            state,
            db,
            cookies: HashMap::new(),
        }
    }

    /// Another client over the same router, and so the same `AppState`, with a
    /// copy of the stored cookies. Lets a test send requests concurrently.
    pub fn fork(&self) -> TestApp {
        TestApp {
            router: self.router.clone(),
            state: self.state.clone(),
            db: self.db.clone(),
            cookies: self.cookies.clone(),
        }
    }

    /// Makes the client lose a cookie, as a browser does when site data is cleared.
    pub fn forget_cookie(&mut self, name: &str) {
        self.cookies.remove(name);
    }

    /// Makes the client hold a cookie that the server did not set.
    pub fn set_cookie(&mut self, name: &str, value: &str) {
        self.cookies.insert(name.to_string(), value.to_string());
    }

    /// Sends a request with the stored cookies and, for non-GET requests,
    /// the CSRF header copied from the stored `op_csrf` cookie.
    pub async fn request(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> TestResponse {
        let csrf = if method == Method::GET {
            None
        } else {
            self.cookies.get(CSRF_COOKIE).cloned()
        };
        self.send(method, path, Payload::Json(body), csrf).await
    }

    /// POSTs `body` verbatim with the given `Content-Type` (or none), for
    /// requests that are not valid JSON.
    pub async fn post_raw(
        &mut self,
        path: &str,
        content_type: Option<&str>,
        body: impl Into<String>,
    ) -> TestResponse {
        let csrf = self.cookies.get(CSRF_COOKIE).cloned();
        let payload = Payload::Raw {
            content_type: content_type.map(str::to_string),
            body: body.into(),
        };
        self.send(Method::POST, path, payload, csrf).await
    }

    /// Same as [`TestApp::request`] but omits the CSRF header.
    pub async fn request_without_csrf(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> TestResponse {
        self.send(method, path, Payload::Json(body), None).await
    }

    pub async fn get(&mut self, path: &str) -> TestResponse {
        self.request(Method::GET, path, None).await
    }

    pub async fn post(&mut self, path: &str, body: Option<Value>) -> TestResponse {
        self.request(Method::POST, path, body).await
    }

    pub async fn patch(&mut self, path: &str, body: Option<Value>) -> TestResponse {
        self.request(Method::PATCH, path, body).await
    }

    pub async fn delete(&mut self, path: &str) -> TestResponse {
        self.request(Method::DELETE, path, None).await
    }

    async fn send(
        &mut self,
        method: Method,
        path: &str,
        payload: Payload,
        csrf: Option<String>,
    ) -> TestResponse {
        let mut builder = Request::builder().method(method).uri(path);
        if !self.cookies.is_empty() {
            let cookie = self
                .cookies
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; ");
            builder = builder.header(header::COOKIE, cookie);
        }
        if let Some(token) = csrf {
            builder = builder.header(CSRF_HEADER, token);
        }
        let body = match payload {
            Payload::Json(Some(json)) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(json.to_string())
            }
            Payload::Json(None) => Body::empty(),
            Payload::Raw { content_type, body } => {
                if let Some(content_type) = content_type {
                    builder = builder.header(header::CONTENT_TYPE, content_type);
                }
                Body::from(body)
            }
        };
        let response = self
            .router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();

        for value in response.headers().get_all(header::SET_COOKIE) {
            let pair = value.to_str().unwrap().split(';').next().unwrap();
            let (name, cookie_value) = pair.split_once('=').unwrap();
            if cookie_value.is_empty() {
                self.cookies.remove(name);
            } else {
                self.cookies
                    .insert(name.to_string(), cookie_value.to_string());
            }
        }

        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        TestResponse {
            status,
            headers,
            text,
            json,
        }
    }
}
