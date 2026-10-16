// Each test crate compiles this module and uses only part of it.
#![allow(dead_code)]

use std::{collections::HashMap, net::SocketAddr};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use openplan_engine::{
    Format, LineItem, LineItemId, ModuleId, SummaryMethod, TimeScale, VersionsScope,
};
use openplan_server::{
    app::{AppState, build_router},
    auth::{CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE},
    config::Config,
    live::{Live, LiveSettings},
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions, types::Json};
use tower::ServiceExt;
use uuid::Uuid;

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
        TestApp::with_live(db, LiveSettings::default())
    }

    /// An app whose live sockets keep the times in `live`, which a test makes short.
    pub fn with_live(db: PgPool, live: LiveSettings) -> TestApp {
        let config = Config::from_lookup(|name| match name {
            "DATABASE_URL" => Some("postgres://invalid".to_string()),
            "OPENPLAN_PUBLIC_URL" => Some("http://localhost:8080".to_string()),
            _ => None,
        })
        .expect("test config is valid");
        let mut state = AppState::new(db.clone(), config);
        state.live = Live::new(live);
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

    /// The `Cookie` header and the CSRF token of the signed-in client, for requests that are sent
    /// over a socket instead of through the router.
    pub fn credentials(&self) -> (String, String) {
        let cookie = self
            .cookies
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        (
            cookie,
            self.cookies.get(CSRF_COOKIE).cloned().unwrap_or_default(),
        )
    }

    /// Serves the app on a port of the local machine, as the binary does, and returns the
    /// address. The server runs until the test ends.
    pub async fn serve(&self) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = self
            .router
            .clone()
            .into_make_service_with_connect_info::<SocketAddr>();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        address
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

pub const ADMIN_EMAIL: &str = "admin@acme.com";
pub const PASSWORD: &str = "correct horse battery";

/// The body of the first-run setup request.
pub fn setup_body() -> Value {
    json!({
        "email": ADMIN_EMAIL,
        "name": "Ada Admin",
        "password": PASSWORD,
        "workspace_name": "Acme",
    })
}

/// Completes first-run setup and returns the response, which has the user and the "Acme"
/// workspace it creates.
pub async fn post_setup(app: &mut TestApp) -> TestResponse {
    let response = app.post("/api/v1/setup", Some(setup_body())).await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response
}

/// Completes first-run setup and returns the id of the "Acme" workspace it creates.
pub async fn setup_admin(app: &mut TestApp) -> String {
    setup_admin_with_id(app).await.0
}

/// Completes first-run setup and returns the ids of the "Acme" workspace it creates and of the
/// admin.
pub async fn setup_admin_with_id(app: &mut TestApp) -> (String, Uuid) {
    let response = post_setup(app).await;
    let workspace = response.json["workspace"]["id"].as_str().unwrap();
    let admin = response.json["user"]["id"].as_str().unwrap();
    (workspace.to_string(), admin.parse().unwrap())
}

/// Creates a user as the signed-in `admin` and returns their id.
pub async fn create_user(admin: &mut TestApp, email: &str, name: &str) -> String {
    let response = admin
        .post(
            "/api/v1/users",
            Some(json!({
                "email": email,
                "name": name,
                "password": PASSWORD,
                "is_instance_admin": false,
            })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json["id"].as_str().unwrap().to_string()
}

/// A client signed in as `email`, whose password is `PASSWORD`.
pub async fn sign_in(pool: &PgPool, email: &str) -> TestApp {
    let mut app = TestApp::new(pool.clone());
    let response = app
        .post(
            "/api/v1/auth/login",
            Some(json!({ "email": email, "password": PASSWORD })),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    app
}

/// Creates a user and adds them to `workspace_id` with `role`, as the signed-in `admin`.
/// Returns the new user's id.
pub async fn create_member(
    admin: &mut TestApp,
    workspace_id: &str,
    email: &str,
    name: &str,
    role: &str,
) -> String {
    let user_id = create_user(admin, email, name).await;
    let added = admin
        .post(
            &format!("/api/v1/workspaces/{workspace_id}/members"),
            Some(json!({ "email": email, "role": role })),
        )
        .await;
    assert_eq!(added.status, StatusCode::CREATED, "{}", added.text);
    user_id
}

/// Creates a model named `name` in a workspace as the signed-in `admin` and returns its id.
pub async fn create_model(admin: &mut TestApp, workspace_id: &str, name: &str) -> String {
    let response = admin
        .post(
            &format!("/api/v1/workspaces/{workspace_id}/models"),
            Some(json!({ "name": name })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json["id"].as_str().unwrap().to_string()
}

/// Asserts an `application/problem+json` response with this status and code.
pub fn assert_problem(response: &TestResponse, status: StatusCode, code: &str) {
    assert_eq!(response.status, status, "{}", response.text);
    let content_type = response.headers[header::CONTENT_TYPE].to_str().unwrap();
    assert!(
        content_type.starts_with("application/problem+json"),
        "{content_type}"
    );
    assert_eq!(response.json["code"], code, "{}", response.text);
}

/// The path of a model in the API; `rest` is what follows it.
pub fn url(model: &str, rest: &str) -> String {
    format!("/api/v1/models/{model}{rest}")
}

/// The `id` of a created thing.
pub fn id_of(json: &Value) -> String {
    json["id"].as_str().unwrap().to_string()
}

/// Signs the admin up to a workspace called Acme, and gives a new model a calendar of the three
/// years from January 2026, so that the period labels in these tests mean the same whatever the
/// date they run on. Returns the admin, the workspace and the model.
pub async fn plan(pool: &PgPool) -> (TestApp, String, String) {
    plan_in(TestApp::new(pool.clone())).await
}

/// [`plan`] in an app that was made, such as one with short times for its live sockets.
pub async fn plan_in(mut admin: TestApp) -> (TestApp, String, String) {
    let workspace = setup_admin(&mut admin).await;
    let model = create_model(&mut admin, &workspace, "Plan").await;
    let calendar = admin
        .request(
            Method::PUT,
            &url(&model, "/calendar"),
            Some(json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 3 })),
        )
        .await;
    assert_eq!(calendar.status, StatusCode::OK, "{}", calendar.text);
    (admin, workspace, model)
}

/// A client signed in as `email` on the same server as `app`, which is the same models in memory
/// (`sign_in` starts a server of its own, and a model has one actor on each).
pub async fn sign_in_beside(app: &TestApp, email: &str) -> TestApp {
    let mut other = app.fork();
    other.forget_cookie(SESSION_COOKIE);
    other.forget_cookie(CSRF_COOKIE);
    let response = other
        .post(
            "/api/v1/auth/login",
            Some(json!({ "email": email, "password": PASSWORD })),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    other
}

/// A Time dimension of months.
pub fn month() -> Value {
    json!({ "kind": "time", "level": "month", "range": null })
}

/// A dimension of a list.
pub fn list_axis(list: &str) -> Value {
    json!({ "kind": "list", "list": list })
}

/// Creates a list from the request `body` and returns its id.
pub async fn create_list(app: &mut TestApp, model: &str, body: Value) -> String {
    let response = app.post(&url(model, "/lists"), Some(body)).await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    id_of(&response.json)
}

/// Adds the `items` of the request to a list and returns them as created.
pub async fn create_items(app: &mut TestApp, model: &str, list: &str, items: Value) -> Vec<Value> {
    let response = app
        .post(
            &url(model, &format!("/lists/{list}/items")),
            Some(json!({ "items": items })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json.as_array().unwrap().clone()
}

/// Creates a module with these dimensions and returns its id.
pub async fn create_module(app: &mut TestApp, model: &str, name: &str, axes: Vec<Value>) -> String {
    let response = app
        .post(
            &url(model, "/modules"),
            Some(json!({ "name": name, "axes": axes })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    id_of(&response.json)
}

/// Creates a line item from the request `body` and returns it as created.
pub async fn create_line_item(app: &mut TestApp, model: &str, module: &str, body: Value) -> Value {
    let response = app
        .post(
            &url(model, &format!("/modules/{module}/line-items")),
            Some(body),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json
}

/// The structure of a model, as the API shows it.
pub async fn structure(app: &mut TestApp, model: &str) -> Value {
    let response = app.get(&url(model, "/structure")).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json
}

/// Every change-log row of a model, whatever its kind.
pub async fn change_rows(pool: &PgPool, model: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM change_log WHERE model_id = $1")
        .bind(Uuid::parse_str(model).unwrap())
        .fetch_one(pool)
        .await
        .unwrap()
}

/// A model row, and the user who edits it, in a database of their own.
pub struct Stored {
    pub id: Uuid,
    pub user: Uuid,
}

/// Inserts a user, a workspace and a model with no stored state, as a model created before the
/// engine existed would be, over a calendar of the twelve months of 2026.
pub async fn insert_model(pool: &PgPool) -> Stored {
    let user = Uuid::now_v7();
    let workspace = Uuid::now_v7();
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Ada')")
        .bind(user)
        .bind(format!("ada-{user}@acme.com"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspaces (id, name) VALUES ($1, $2)")
        .bind(workspace)
        .bind(format!("Acme {workspace}"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO models (id, workspace_id, name, calendar) VALUES ($1, $2, 'Plan', $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(Json(
        json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 1 }),
    ))
    .execute(pool)
    .await
    .unwrap();
    Stored { id, user }
}

/// A line item of the engine, summed over every dimension, with the defaults of a new one.
pub fn line_item(module: ModuleId, name: &str, format: Format, formula: Option<&str>) -> LineItem {
    LineItem {
        id: LineItemId::new(),
        module,
        name: name.to_string(),
        ordinal: 0,
        format,
        formula: formula.map(str::to_string),
        summary: SummaryMethod::Sum,
        time_summary: None,
        applies_to: None,
        time_scale: TimeScale::Module,
        versions: VersionsScope::Module,
        notes: String::new(),
        code: None,
        read_access_driver: None,
        write_access_driver: None,
    }
}
