use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, patch},
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection, PgPool};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    app::AppState,
    auth::CurrentUser,
    authz::{WorkspaceRole, require_instance_admin, require_workspace_role},
    error::{AppError, AppResult},
    extract::{ApiJson, ApiPath},
    validate,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/workspaces", get(list_workspaces).post(create_workspace))
        .route(
            "/workspaces/{id}",
            patch(rename_workspace).delete(delete_workspace),
        )
        .route(
            "/workspaces/{id}/members",
            get(list_members).post(add_member),
        )
        .route(
            "/workspaces/{id}/members/{user_id}",
            patch(change_member_role).delete(remove_member),
        )
}

#[derive(Serialize, ToSchema, FromRow)]
pub struct WorkspaceSummary {
    pub id: Uuid,
    pub name: String,
    pub role: WorkspaceRole,
}

#[derive(Serialize, ToSchema, FromRow)]
pub struct MemberDto {
    user_id: Uuid,
    email: String,
    name: String,
    role: WorkspaceRole,
}

#[derive(Deserialize, ToSchema)]
pub struct WorkspaceNameRequest {
    name: String,
}

#[derive(Deserialize, ToSchema)]
pub struct AddMemberRequest {
    email: String,
    role: WorkspaceRole,
}

#[derive(Deserialize, ToSchema)]
pub struct ChangeRoleRequest {
    role: WorkspaceRole,
}

#[derive(FromRow)]
struct LockedMember {
    user_id: Uuid,
    role: WorkspaceRole,
}

fn last_admin() -> AppError {
    AppError::Conflict {
        code: "workspace.last_admin",
        detail: "A workspace needs at least one admin.".into(),
    }
}

fn member_exists() -> AppError {
    AppError::Conflict {
        code: "workspace.member_exists",
        detail: "That user is already a member of this workspace.".into(),
    }
}

/// A duplicate membership is `workspace.member_exists`. A missing workspace or
/// user is `not_found`: the workspace can be deleted after the caller was
/// authorized for it.
fn map_member_insert_error(err: sqlx::Error) -> AppError {
    match err {
        sqlx::Error::Database(db_err) if db_err.is_unique_violation() => member_exists(),
        sqlx::Error::Database(db_err) if db_err.is_foreign_key_violation() => AppError::NotFound,
        other => other.into(),
    }
}

fn email_not_found() -> AppError {
    AppError::CodedNotFound {
        code: "user.not_found",
        detail: "No user with that email. Ask an instance admin to create the account.".into(),
    }
}

/// The workspaces the user can open, ordered by name, with their role in each.
/// Instance admins see every workspace as its admin.
pub async fn list_for_user(db: &PgPool, user: &CurrentUser) -> AppResult<Vec<WorkspaceSummary>> {
    let workspaces = if user.is_instance_admin {
        sqlx::query_as::<_, WorkspaceSummary>(
            "SELECT id, name, 'admin' AS role FROM workspaces ORDER BY name, id",
        )
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_as::<_, WorkspaceSummary>(
            "SELECT w.id, w.name, m.role
             FROM workspaces w
             JOIN workspace_members m ON m.workspace_id = w.id
             WHERE m.user_id = $1
             ORDER BY w.name, w.id",
        )
        .bind(user.id)
        .fetch_all(db)
        .await?
    };
    Ok(workspaces)
}

/// Locks the workspace's admin member rows and the row of `user_id` (in a fixed
/// order, so concurrent changes queue up instead of deadlocking), then fails
/// with `workspace.last_admin` if the change would leave the workspace without
/// an admin. `new_role` is the role the member is about to get, or `None` when
/// they are about to be removed. The change must run in the same transaction.
/// Only member rows count: an instance admin is an admin of every workspace
/// but not an admin member of any.
async fn guard_last_admin(
    tx: &mut PgConnection,
    workspace_id: Uuid,
    user_id: Uuid,
    new_role: Option<WorkspaceRole>,
) -> AppResult<()> {
    let locked = sqlx::query_as::<_, LockedMember>(
        "SELECT user_id, role FROM workspace_members
         WHERE workspace_id = $1 AND (role = 'admin' OR user_id = $2)
         ORDER BY user_id
         FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    let target = locked
        .iter()
        .find(|member| member.user_id == user_id)
        .ok_or(AppError::NotFound)?;
    let admins = locked
        .iter()
        .filter(|member| member.role == WorkspaceRole::Admin)
        .count();
    if target.role == WorkspaceRole::Admin && new_role != Some(WorkspaceRole::Admin) && admins == 1
    {
        return Err(last_admin());
    }
    Ok(())
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces",
    tag = "workspaces",
    responses(
        (status = 200, description = "The workspaces the user can open, ordered by name", body = [WorkspaceSummary]),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
    )
)]
pub(crate) async fn list_workspaces(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Vec<WorkspaceSummary>>> {
    Ok(Json(list_for_user(&state.db, &user).await?))
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces",
    tag = "workspaces",
    request_body = WorkspaceNameRequest,
    responses(
        (status = 201, description = "The workspace was created and the caller is its admin", body = WorkspaceSummary),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not an instance admin (auth.forbidden)"),
        (status = 422, description = "The name is invalid (validation)"),
    )
)]
pub(crate) async fn create_workspace(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<WorkspaceNameRequest>,
) -> AppResult<(StatusCode, Json<WorkspaceSummary>)> {
    require_instance_admin(&user)?;
    let name = validate::entity_name("name", &body.name)?;
    let workspace = WorkspaceSummary {
        id: Uuid::now_v7(),
        name,
        role: WorkspaceRole::Admin,
    };

    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO workspaces (id, name) VALUES ($1, $2)")
        .bind(workspace.id)
        .bind(&workspace.name)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)")
        .bind(workspace.id)
        .bind(user.id)
        .bind(workspace.role)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(workspace)))
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/{id}",
    tag = "workspaces",
    params(("id" = Uuid, Path, description = "The workspace's id")),
    request_body = WorkspaceNameRequest,
    responses(
        (status = 200, description = "The renamed workspace", body = WorkspaceSummary),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace admin (auth.forbidden)"),
        (status = 404, description = "No such workspace, or the caller is not a member (not_found)"),
        (status = 422, description = "The name is invalid (validation)"),
    )
)]
pub(crate) async fn rename_workspace(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<WorkspaceNameRequest>,
) -> AppResult<Json<WorkspaceSummary>> {
    let role = require_workspace_role(&state.db, &user, id, WorkspaceRole::Admin).await?;
    let name = validate::entity_name("name", &body.name)?;
    let name: String = sqlx::query_scalar(
        "UPDATE workspaces SET name = $2, updated_at = now() WHERE id = $1 RETURNING name",
    )
    .bind(id)
    .bind(name)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(WorkspaceSummary { id, name, role }))
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{id}",
    tag = "workspaces",
    params(("id" = Uuid, Path, description = "The workspace's id")),
    responses(
        (status = 204, description = "The workspace and everything in it was deleted"),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not an instance admin (auth.forbidden)"),
        (status = 404, description = "No such workspace (not_found)"),
    )
)]
pub(crate) async fn delete_workspace(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<Uuid>,
) -> AppResult<StatusCode> {
    require_instance_admin(&user)?;
    let deleted = sqlx::query("DELETE FROM workspaces WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{id}/members",
    tag = "workspaces",
    params(("id" = Uuid, Path, description = "The workspace's id")),
    responses(
        (status = 200, description = "The workspace's members, ordered by name", body = [MemberDto]),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 404, description = "No such workspace, or the caller is not a member (not_found)"),
    )
)]
pub(crate) async fn list_members(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<Uuid>,
) -> AppResult<Json<Vec<MemberDto>>> {
    require_workspace_role(&state.db, &user, id, WorkspaceRole::Viewer).await?;
    let members = sqlx::query_as::<_, MemberDto>(
        "SELECT m.user_id, u.email, u.name, m.role
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = $1
         ORDER BY u.name, u.id",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(members))
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{id}/members",
    tag = "workspaces",
    params(("id" = Uuid, Path, description = "The workspace's id")),
    request_body = AddMemberRequest,
    responses(
        (status = 201, description = "The user was added to the workspace", body = MemberDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace admin (auth.forbidden)"),
        (status = 404, description = "No such workspace (not_found), or no user has that email (user.not_found)"),
        (status = 409, description = "The user is already a member (workspace.member_exists)"),
        (status = 422, description = "Some fields are invalid (validation)"),
    )
)]
pub(crate) async fn add_member(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<AddMemberRequest>,
) -> AppResult<(StatusCode, Json<MemberDto>)> {
    require_workspace_role(&state.db, &user, id, WorkspaceRole::Admin).await?;
    let email = validate::email(&body.email)?;
    let (user_id, email, name): (Uuid, String, String) =
        sqlx::query_as("SELECT id, email, name FROM users WHERE lower(email) = $1")
            .bind(email)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(email_not_found)?;
    sqlx::query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(user_id)
        .bind(body.role)
        .execute(&state.db)
        .await
        .map_err(map_member_insert_error)?;
    let member = MemberDto {
        user_id,
        email,
        name,
        role: body.role,
    };
    Ok((StatusCode::CREATED, Json(member)))
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/{id}/members/{user_id}",
    tag = "workspaces",
    params(
        ("id" = Uuid, Path, description = "The workspace's id"),
        ("user_id" = Uuid, Path, description = "The member's user id"),
    ),
    request_body = ChangeRoleRequest,
    responses(
        (status = 200, description = "The member with their new role", body = MemberDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace admin (auth.forbidden)"),
        (status = 404, description = "No such workspace or member (not_found)"),
        (status = 409, description = "The member is the last admin (workspace.last_admin)"),
        (status = 422, description = "The role is invalid (validation)"),
    )
)]
pub(crate) async fn change_member_role(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath((id, user_id)): ApiPath<(Uuid, Uuid)>,
    ApiJson(body): ApiJson<ChangeRoleRequest>,
) -> AppResult<Json<MemberDto>> {
    require_workspace_role(&state.db, &user, id, WorkspaceRole::Admin).await?;

    let mut tx = state.db.begin().await?;
    guard_last_admin(&mut tx, id, user_id, Some(body.role)).await?;
    let member = sqlx::query_as::<_, MemberDto>(
        "WITH changed AS (
           UPDATE workspace_members SET role = $3
           WHERE workspace_id = $1 AND user_id = $2
           RETURNING user_id, role
         )
         SELECT changed.user_id, u.email, u.name, changed.role
         FROM changed JOIN users u ON u.id = changed.user_id",
    )
    .bind(id)
    .bind(user_id)
    .bind(body.role)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(member))
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{id}/members/{user_id}",
    tag = "workspaces",
    params(
        ("id" = Uuid, Path, description = "The workspace's id"),
        ("user_id" = Uuid, Path, description = "The member's user id"),
    ),
    responses(
        (status = 204, description = "The member was removed from the workspace"),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace admin (auth.forbidden)"),
        (status = 404, description = "No such workspace or member (not_found)"),
        (status = 409, description = "The member is the last admin (workspace.last_admin)"),
    )
)]
pub(crate) async fn remove_member(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath((id, user_id)): ApiPath<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    require_workspace_role(&state.db, &user, id, WorkspaceRole::Admin).await?;

    let mut tx = state.db.begin().await?;
    guard_last_admin(&mut tx, id, user_id, None).await?;
    sqlx::query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use std::{error::Error as StdError, fmt};

    use sqlx::error::{DatabaseError, ErrorKind};

    use super::*;

    #[derive(Debug)]
    enum Violation {
        Unique,
        ForeignKey,
        Other,
    }

    /// A database error of a fixed kind, standing in for one Postgres reports.
    #[derive(Debug)]
    struct FakeDatabaseError(Violation);

    impl fmt::Display for FakeDatabaseError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("fake database error")
        }
    }

    impl StdError for FakeDatabaseError {}

    impl DatabaseError for FakeDatabaseError {
        fn message(&self) -> &str {
            "fake database error"
        }

        fn as_error(&self) -> &(dyn StdError + Send + Sync + 'static) {
            self
        }

        fn as_error_mut(&mut self) -> &mut (dyn StdError + Send + Sync + 'static) {
            self
        }

        fn into_error(self: Box<Self>) -> Box<dyn StdError + Send + Sync + 'static> {
            self
        }

        fn kind(&self) -> ErrorKind {
            match self.0 {
                Violation::Unique => ErrorKind::UniqueViolation,
                Violation::ForeignKey => ErrorKind::ForeignKeyViolation,
                Violation::Other => ErrorKind::Other,
            }
        }
    }

    fn database_error(violation: Violation) -> sqlx::Error {
        sqlx::Error::Database(Box::new(FakeDatabaseError(violation)))
    }

    #[test]
    fn member_insert_maps_unique_violation_to_member_exists() {
        assert!(matches!(
            map_member_insert_error(database_error(Violation::Unique)),
            AppError::Conflict {
                code: "workspace.member_exists",
                ..
            }
        ));
    }

    #[test]
    fn member_insert_maps_foreign_key_violation_to_not_found() {
        // The workspace was deleted after the caller was authorized for it.
        assert!(matches!(
            map_member_insert_error(database_error(Violation::ForeignKey)),
            AppError::NotFound
        ));
    }

    #[test]
    fn other_member_insert_errors_stay_internal() {
        assert!(matches!(
            map_member_insert_error(database_error(Violation::Other)),
            AppError::Internal(_)
        ));
        assert!(matches!(
            map_member_insert_error(sqlx::Error::PoolTimedOut),
            AppError::Internal(_)
        ));
    }
}
