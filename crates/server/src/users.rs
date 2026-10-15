use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, patch},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    app::AppState,
    auth::{CurrentUser, password, session},
    authz::require_instance_admin,
    error::{AppError, AppResult, FieldError},
    extract::{ApiJson, ApiPath},
    validate,
};

const OWN_ACCOUNT_MESSAGE: &str = "You can't change this for your own account.";
const OWN_PASSWORD_MESSAGE: &str = "Use your profile to change your own password.";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/users", get(list_users).post(create_user))
        .route("/users/{id}", patch(update_user))
}

#[derive(Serialize, ToSchema, FromRow)]
pub struct UserDto {
    id: Uuid,
    email: String,
    name: String,
    is_instance_admin: bool,
    disabled: bool,
    created_at: DateTime<Utc>,
}

#[derive(Deserialize, ToSchema)]
pub struct CreateUserRequest {
    email: String,
    name: String,
    password: String,
    is_instance_admin: bool,
}

#[derive(Deserialize, ToSchema)]
pub struct UpdateUserRequest {
    name: Option<String>,
    is_instance_admin: Option<bool>,
    disabled: Option<bool>,
    password: Option<String>,
}

fn email_taken() -> AppError {
    AppError::Conflict {
        code: "user.email_taken",
        detail: "Email is already registered.".into(),
    }
}

fn user_not_found() -> AppError {
    AppError::CodedNotFound {
        code: "user.not_found",
        detail: "No user has that id.".into(),
    }
}

fn last_instance_admin() -> AppError {
    AppError::Conflict {
        code: "user.last_instance_admin",
        detail: "An instance needs at least one administrator.".into(),
    }
}

fn own_account_rejection(forbidden: bool, field: &str, message: &str) -> Result<(), FieldError> {
    if forbidden {
        Err(FieldError {
            field: field.into(),
            message: message.into(),
        })
    } else {
        Ok(())
    }
}

/// Refuses a change that would take `user_id`, the only enabled instance admin,
/// out of that role. Locks every enabled instance admin in id order, so two
/// admins who demote or disable each other queue instead of both succeeding.
/// The change must run in the same transaction.
async fn guard_last_instance_admin(tx: &mut PgConnection, user_id: Uuid) -> AppResult<()> {
    let admins = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM users WHERE is_instance_admin AND NOT disabled ORDER BY id FOR UPDATE",
    )
    .fetch_all(&mut *tx)
    .await?;
    if admins == [user_id] {
        return Err(last_instance_admin());
    }
    Ok(())
}

#[utoipa::path(
    get,
    path = "/api/v1/users",
    tag = "users",
    responses(
        (status = 200, description = "Every user, ordered by name", body = [UserDto]),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not an instance admin (auth.forbidden)"),
    )
)]
pub(crate) async fn list_users(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Vec<UserDto>>> {
    require_instance_admin(&user)?;
    let users = sqlx::query_as::<_, UserDto>(
        "SELECT id, email, name, is_instance_admin, disabled, created_at
         FROM users ORDER BY name, id",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(users))
}

#[utoipa::path(
    post,
    path = "/api/v1/users",
    tag = "users",
    request_body = CreateUserRequest,
    responses(
        (status = 201, description = "The user was created", body = UserDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not an instance admin (auth.forbidden)"),
        (status = 409, description = "The email is already registered (user.email_taken)"),
        (status = 422, description = "Some fields are invalid (validation)"),
    )
)]
pub(crate) async fn create_user(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<CreateUserRequest>,
) -> AppResult<(StatusCode, Json<UserDto>)> {
    require_instance_admin(&user)?;
    let email = validate::email(&body.email);
    let name = validate::person_name(&body.name);
    let password = validate::password(&body.password);
    validate::collect(vec![
        email.clone().map(drop),
        name.clone().map(drop),
        password,
    ])?;
    let (email, name) = (email?, name?);
    let password_hash = password::hash_password_async(body.password).await?;

    let created = sqlx::query_as::<_, UserDto>(
        "INSERT INTO users (id, email, name, password_hash, is_instance_admin)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, name, is_instance_admin, disabled, created_at",
    )
    .bind(Uuid::now_v7())
    .bind(email)
    .bind(name)
    .bind(password_hash)
    .bind(body.is_instance_admin)
    .fetch_one(&state.db)
    .await
    .map_err(|err| match err {
        sqlx::Error::Database(db_err) if db_err.is_unique_violation() => email_taken(),
        other => other.into(),
    })?;
    Ok((StatusCode::CREATED, Json(created)))
}

#[utoipa::path(
    patch,
    path = "/api/v1/users/{id}",
    tag = "users",
    params(("id" = Uuid, Path, description = "The user's id")),
    request_body = UpdateUserRequest,
    responses(
        (status = 200, description = "The updated user", body = UserDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not an instance admin (auth.forbidden)"),
        (status = 404, description = "No such user (user.not_found)"),
        (status = 409, description = "The user is the last instance admin (user.last_instance_admin)"),
        (status = 422, description = "Some fields are invalid (validation)"),
    )
)]
pub(crate) async fn update_user(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<UpdateUserRequest>,
) -> AppResult<Json<UserDto>> {
    require_instance_admin(&user)?;
    let own_account = id == user.id;
    let name = body.name.as_deref().map(validate::person_name).transpose();
    validate::collect(vec![
        name.clone().map(drop),
        body.password.as_deref().map_or(Ok(()), validate::password),
        own_account_rejection(
            own_account && body.disabled == Some(true),
            "disabled",
            OWN_ACCOUNT_MESSAGE,
        ),
        own_account_rejection(
            own_account && body.is_instance_admin == Some(false),
            "is_instance_admin",
            OWN_ACCOUNT_MESSAGE,
        ),
        own_account_rejection(
            own_account && body.password.is_some(),
            "password",
            OWN_PASSWORD_MESSAGE,
        ),
    ])?;
    let name = name?;
    let revokes_sessions = body.disabled == Some(true) || body.password.is_some();
    let password_hash = match body.password {
        Some(plain) => Some(password::hash_password_async(plain).await?),
        None => None,
    };

    let mut tx = state.db.begin().await?;
    if body.is_instance_admin == Some(false) || body.disabled == Some(true) {
        guard_last_instance_admin(&mut tx, id).await?;
    }
    let updated = sqlx::query_as::<_, UserDto>(
        "UPDATE users SET
           name = COALESCE($2, name),
           is_instance_admin = COALESCE($3, is_instance_admin),
           disabled = COALESCE($4, disabled),
           password_hash = COALESCE($5, password_hash),
           updated_at = now()
         WHERE id = $1
         RETURNING id, email, name, is_instance_admin, disabled, created_at",
    )
    .bind(id)
    .bind(name)
    .bind(body.is_instance_admin)
    .bind(body.disabled)
    .bind(password_hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(user_not_found)?;
    if revokes_sessions {
        session::delete_all_for_user(&mut *tx, id).await?;
    }
    tx.commit().await?;
    Ok(Json(updated))
}
