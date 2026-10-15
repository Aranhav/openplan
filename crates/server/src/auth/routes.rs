use std::net::SocketAddr;

use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::Response,
    routing::{get, post},
};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    app::AppState,
    error::{AppError, AppResult},
    extract::ApiJson,
    validate,
};

use super::{CurrentUser, SESSION_COOKIE, clear_cookies, password, session, session_cookies};

const SETUP_LOCK_KEY: i64 = 4242;
const UNKNOWN_IP: &str = "unknown";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/setup/status", get(setup_status))
        .route("/setup", post(setup))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .layer(middleware::map_response(no_store))
}

async fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Serialize, ToSchema)]
pub struct SetupStatus {
    needs_setup: bool,
}

#[derive(Deserialize, ToSchema)]
pub struct SetupRequest {
    email: String,
    name: String,
    password: String,
    workspace_name: String,
}

#[derive(Serialize, ToSchema)]
pub struct WorkspaceSummary {
    id: Uuid,
    name: String,
}

#[derive(Serialize, ToSchema)]
pub struct SetupResponse {
    user: CurrentUser,
    workspace: WorkspaceSummary,
}

#[derive(Deserialize, ToSchema)]
pub struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Serialize, ToSchema)]
pub struct LoginResponse {
    user: CurrentUser,
}

#[derive(Serialize, FromRow, ToSchema)]
pub struct WorkspaceMembership {
    id: Uuid,
    name: String,
    role: String,
}

#[derive(Serialize, ToSchema)]
pub struct MeResponse {
    user: CurrentUser,
    workspaces: Vec<WorkspaceMembership>,
}

#[derive(FromRow)]
struct LoginCandidate {
    #[sqlx(flatten)]
    user: CurrentUser,
    password_hash: Option<String>,
}

async fn any_user_exists(db: impl sqlx::PgExecutor<'_>) -> AppResult<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users)")
        .fetch_one(db)
        .await?)
}

fn setup_already_done() -> AppError {
    AppError::Conflict {
        code: "setup.already_done",
        detail: "Setup has already been completed.".into(),
    }
}

fn user_agent(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
}

#[utoipa::path(
    get,
    path = "/api/v1/setup/status",
    tag = "auth",
    responses((status = 200, description = "Whether first-run setup is still needed", body = SetupStatus))
)]
pub(crate) async fn setup_status(State(state): State<AppState>) -> AppResult<Json<SetupStatus>> {
    Ok(Json(SetupStatus {
        needs_setup: !any_user_exists(&state.db).await?,
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/setup",
    tag = "auth",
    request_body = SetupRequest,
    responses(
        (status = 201, description = "The first admin and workspace were created and signed in", body = SetupResponse),
        (status = 409, description = "Setup was already completed (setup.already_done)"),
        (status = 422, description = "Some fields are invalid (validation)"),
    )
)]
pub(crate) async fn setup(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(body): ApiJson<SetupRequest>,
) -> AppResult<(StatusCode, CookieJar, Json<SetupResponse>)> {
    let email = validate::email(&body.email);
    let name = validate::person_name(&body.name);
    let password = validate::password(&body.password);
    let workspace_name = validate::entity_name("workspace_name", &body.workspace_name);
    validate::collect(vec![
        email.clone().map(drop),
        name.clone().map(drop),
        password,
        workspace_name.clone().map(drop),
    ])?;
    let (email, name, workspace_name) = (email?, name?, workspace_name?);
    if any_user_exists(&state.db).await? {
        return Err(setup_already_done());
    }
    let password_hash = password::hash_password_async(body.password).await?;

    let user = CurrentUser {
        id: Uuid::now_v7(),
        email,
        name,
        is_instance_admin: true,
    };
    let workspace = WorkspaceSummary {
        id: Uuid::now_v7(),
        name: workspace_name,
    };

    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(SETUP_LOCK_KEY)
        .execute(&mut *tx)
        .await?;
    if any_user_exists(&mut *tx).await? {
        return Err(setup_already_done());
    }
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, is_instance_admin)
         VALUES ($1, $2, $3, $4, true)",
    )
    .bind(user.id)
    .bind(&user.email)
    .bind(&user.name)
    .bind(&password_hash)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO workspaces (id, name) VALUES ($1, $2)")
        .bind(workspace.id)
        .bind(&workspace.name)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
    )
    .bind(workspace.id)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let token = session::create(&state.db, user.id, user_agent(&headers)).await?;
    let (session_cookie, csrf_cookie) = session_cookies(&token, state.config.secure_cookies());
    Ok((
        StatusCode::CREATED,
        CookieJar::new().add(session_cookie).add(csrf_cookie),
        Json(SetupResponse { user, workspace }),
    ))
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/login",
    tag = "auth",
    request_body = LoginRequest,
    responses(
        (status = 200, description = "Signed in", body = LoginResponse),
        (status = 401, description = "Email or password is incorrect (auth.invalid_credentials)"),
        (status = 422, description = "A field is missing or has the wrong type (validation)"),
        (status = 429, description = "Too many failed attempts (auth.rate_limited)"),
    )
)]
pub(crate) async fn login(
    State(state): State<AppState>,
    connect_info: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    ApiJson(body): ApiJson<LoginRequest>,
) -> AppResult<(CookieJar, Json<LoginResponse>)> {
    let Ok(email) = validate::email(&body.email) else {
        return Err(AppError::InvalidCredentials);
    };
    let ip = connect_info.map_or_else(
        || UNKNOWN_IP.to_string(),
        |Extension(ConnectInfo(addr))| addr.ip().to_string(),
    );
    let limiter_key = format!("{email}|{ip}");
    state
        .login_limiter
        .check_and_record(&limiter_key)
        .map_err(|retry_after_secs| AppError::RateLimited { retry_after_secs })?;

    let candidate = sqlx::query_as::<_, LoginCandidate>(
        "SELECT id, email, name, is_instance_admin, password_hash FROM users
         WHERE lower(email) = lower($1) AND NOT disabled",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;
    let hash = candidate
        .as_ref()
        .and_then(|candidate| candidate.password_hash.clone());
    let verified = password::verify_password_async(body.password, hash).await;
    let user = match candidate {
        Some(candidate) if verified => candidate.user,
        _ => return Err(AppError::InvalidCredentials),
    };
    state.login_limiter.reset(&limiter_key);

    let token = session::create(&state.db, user.id, user_agent(&headers)).await?;
    let (session_cookie, csrf_cookie) = session_cookies(&token, state.config.secure_cookies());
    Ok((
        CookieJar::new().add(session_cookie).add(csrf_cookie),
        Json(LoginResponse { user }),
    ))
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/logout",
    tag = "auth",
    responses((status = 204, description = "Signed out; the session cookies are cleared"))
)]
pub(crate) async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(StatusCode, CookieJar)> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        session::delete(&state.db, cookie.value()).await?;
    }
    let (session_cookie, csrf_cookie) = clear_cookies(state.config.secure_cookies());
    Ok((
        StatusCode::NO_CONTENT,
        jar.add(session_cookie).add(csrf_cookie),
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/auth/me",
    tag = "auth",
    responses(
        (status = 200, description = "The signed-in user and their workspaces", body = MeResponse),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
    )
)]
pub(crate) async fn me(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<MeResponse>> {
    let workspaces = if user.is_instance_admin {
        sqlx::query_as::<_, WorkspaceMembership>(
            "SELECT id, name, 'admin' AS role FROM workspaces ORDER BY name, id",
        )
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, WorkspaceMembership>(
            "SELECT w.id, w.name, m.role
             FROM workspaces w
             JOIN workspace_members m ON m.workspace_id = w.id
             WHERE m.user_id = $1
             ORDER BY w.name, w.id",
        )
        .bind(user.id)
        .fetch_all(&state.db)
        .await?
    };
    Ok(Json(MeResponse { user, workspaces }))
}
