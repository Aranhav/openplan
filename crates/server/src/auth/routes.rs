use std::net::SocketAddr;

use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode, header},
    routing::{get, post},
};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    app::AppState,
    authz::WorkspaceRole,
    client_ip::client_ip,
    error::{AppError, AppResult, FieldError},
    extract::ApiJson,
    validate,
    workspaces::{self, WorkspaceSummary},
};

use super::{CurrentUser, SESSION_COOKIE, clear_cookies, password, session, session_cookies};

const SETUP_LOCK_KEY: i64 = 4242;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/setup/status", get(setup_status))
        .route("/auth/me", get(me).patch(update_me))
        .route("/auth/me/password", post(change_password))
}

/// The routes that start or end a session. They skip the CSRF check, because a
/// browser that kept `op_session` but lost `op_csrf` could not otherwise sign
/// in again or sign out. Sign-in and setup still need a JSON body, and the
/// session cookie is `SameSite=Lax`, so a form on another site cannot use it.
pub fn session_router() -> Router<AppState> {
    Router::new()
        .route("/setup", post(setup))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
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

#[derive(Serialize, ToSchema)]
pub struct MeResponse {
    user: CurrentUser,
    workspaces: Vec<WorkspaceSummary>,
}

#[derive(Deserialize, ToSchema)]
pub struct UpdateProfileRequest {
    name: String,
}

#[derive(Deserialize, ToSchema)]
pub struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
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
        role: WorkspaceRole::Admin,
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
    let peer = connect_info.map(|Extension(ConnectInfo(addr))| addr);
    let ip = client_ip(&headers, peer, state.config.trusted_proxy_hops);
    let limiter_key = format!("{email}|{ip}");
    state
        .login_limiter
        .check_and_record(&limiter_key)
        .map_err(|retry_after_secs| AppError::RateLimited { retry_after_secs })?;
    // Client addresses can be forged when the server is reachable without the proxy, so
    // the email is also capped on its own.
    state
        .login_email_limiter
        .check_and_record(&email)
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
    state.login_email_limiter.reset(&email);

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
    let workspaces = workspaces::list_for_user(&state.db, &user).await?;
    Ok(Json(MeResponse { user, workspaces }))
}

#[utoipa::path(
    patch,
    path = "/api/v1/auth/me",
    tag = "auth",
    request_body = UpdateProfileRequest,
    responses(
        (status = 200, description = "The signed-in user with the new name", body = CurrentUser),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 422, description = "The name is invalid (validation)"),
    )
)]
pub(crate) async fn update_me(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<UpdateProfileRequest>,
) -> AppResult<Json<CurrentUser>> {
    let name = validate::person_name(&body.name)?;
    let updated = sqlx::query_as::<_, CurrentUser>(
        "UPDATE users SET name = $2, updated_at = now() WHERE id = $1
         RETURNING id, email, name, is_instance_admin",
    )
    .bind(user.id)
    .bind(name)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(updated))
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/me/password",
    tag = "auth",
    request_body = ChangePasswordRequest,
    responses(
        (status = 204, description = "The password was changed and the other sessions are signed out"),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 422, description = "The current password is wrong or the new one is invalid (validation)"),
    )
)]
pub(crate) async fn change_password(
    State(state): State<AppState>,
    user: CurrentUser,
    jar: CookieJar,
    ApiJson(body): ApiJson<ChangePasswordRequest>,
) -> AppResult<StatusCode> {
    let token = jar
        .get(SESSION_COOKIE)
        .ok_or(AppError::Unauthenticated)?
        .value();
    validate::password(&body.new_password).map_err(|err| FieldError {
        field: "new_password".into(),
        ..err
    })?;
    // Shares the login limiter; the key prefix keeps the two budgets apart.
    let limiter_key = format!("password|{}", user.id);
    state
        .login_limiter
        .check_and_record(&limiter_key)
        .map_err(|retry_after_secs| AppError::RateLimited { retry_after_secs })?;
    let stored_hash: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_one(&state.db)
            .await?;
    if !password::verify_password_async(body.current_password, stored_hash).await {
        return Err(FieldError {
            field: "current_password".into(),
            message: "Current password is incorrect.".into(),
        }
        .into());
    }
    state.login_limiter.reset(&limiter_key);
    let password_hash = password::hash_password_async(body.new_password).await?;

    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1")
        .bind(user.id)
        .bind(password_hash)
        .execute(&mut *tx)
        .await?;
    session::delete_others(&mut *tx, user.id, token).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
