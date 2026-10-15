use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    app::AppState,
    auth::CurrentUser,
    authz::{WorkspaceRole, require_workspace_role},
    error::{AppError, AppResult, FieldError},
    extract::{ApiJson, ApiPath},
    validate,
};

const DESCRIPTION_MAX: usize = 500;
/// The unique index on a model's name within its workspace, compared without case.
const NAME_INDEX: &str = "models_workspace_name_key";
/// The columns `ModelDto` decodes, in the order every model query selects them.
const MODEL_COLUMNS: &str =
    "id, workspace_id, name, description, mode, calendar, created_by, created_at, updated_at";

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/workspaces/{id}/models",
            get(list_models).post(create_model),
        )
        .route(
            "/models/{id}",
            get(get_model).patch(update_model).delete(delete_model),
        )
}

/// A model's fiscal calendar: the month each fiscal year starts in, the first
/// year, and how many years it covers.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct Calendar {
    pub fiscal_year_start_month: u8,
    pub first_year: i32,
    pub years: u8,
}

/// The model's mode, stored and sent as `dev` or `prod`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub enum ModelMode {
    Dev,
    Prod,
}

#[derive(Serialize, ToSchema, FromRow)]
pub struct ModelDto {
    id: Uuid,
    workspace_id: Uuid,
    name: String,
    description: String,
    mode: ModelMode,
    #[sqlx(json)]
    calendar: Calendar,
    created_by: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Deserialize, ToSchema)]
pub struct CreateModelRequest {
    name: String,
    description: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct UpdateModelRequest {
    name: Option<String>,
    description: Option<String>,
    mode: Option<ModelMode>,
}

fn name_taken() -> AppError {
    AppError::Conflict {
        code: "model.name_taken",
        detail: "A model with this name already exists in this workspace.".into(),
    }
}

/// The calendar of a new model: January fiscal years, three of them, starting
/// in the current UTC year.
fn default_calendar() -> Calendar {
    Calendar {
        fiscal_year_start_month: 1,
        first_year: Utc::now().year(),
        years: 3,
    }
}

fn validate_description(raw: &str) -> Result<String, FieldError> {
    if raw.chars().count() > DESCRIPTION_MAX {
        return Err(FieldError {
            field: "description".into(),
            message: format!("Description must be at most {DESCRIPTION_MAX} characters."),
        });
    }
    Ok(raw.to_string())
}

/// A clash with another model's name in the workspace is `model.name_taken`. A
/// missing workspace is `not_found`: it can be deleted after the caller was
/// authorized for it.
fn map_model_write_error(err: sqlx::Error) -> AppError {
    match err {
        sqlx::Error::Database(db_err)
            if db_err.is_unique_violation() && db_err.constraint() == Some(NAME_INDEX) =>
        {
            name_taken()
        }
        sqlx::Error::Database(db_err) if db_err.is_foreign_key_violation() => AppError::NotFound,
        other => other.into(),
    }
}

/// The workspace that owns a model, or `NotFound` when no model has that id.
async fn model_workspace(db: &PgPool, model_id: Uuid) -> AppResult<Uuid> {
    sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM models WHERE id = $1")
        .bind(model_id)
        .fetch_optional(db)
        .await?
        .ok_or(AppError::NotFound)
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{id}/models",
    tag = "models",
    params(("id" = Uuid, Path, description = "The workspace's id")),
    responses(
        (status = 200, description = "The workspace's models, most recently updated first", body = [ModelDto]),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 404, description = "No such workspace, or the caller is not a member (not_found)"),
    )
)]
pub(crate) async fn list_models(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(workspace_id): ApiPath<Uuid>,
) -> AppResult<Json<Vec<ModelDto>>> {
    require_workspace_role(&state.db, &user, workspace_id, WorkspaceRole::Viewer).await?;
    let models = sqlx::query_as::<_, ModelDto>(&format!(
        "SELECT {MODEL_COLUMNS}
         FROM models
         WHERE workspace_id = $1
         ORDER BY updated_at DESC, id DESC"
    ))
    .bind(workspace_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(models))
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{id}/models",
    tag = "models",
    params(("id" = Uuid, Path, description = "The workspace's id")),
    request_body = CreateModelRequest,
    responses(
        (status = 201, description = "The model was created with the default calendar", body = ModelDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such workspace, or the caller is not a member (not_found)"),
        (status = 409, description = "A model with that name already exists in the workspace (model.name_taken)"),
        (status = 422, description = "Some fields are invalid (validation)"),
    )
)]
pub(crate) async fn create_model(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(workspace_id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<CreateModelRequest>,
) -> AppResult<(StatusCode, Json<ModelDto>)> {
    require_workspace_role(&state.db, &user, workspace_id, WorkspaceRole::Builder).await?;
    let name = validate::entity_name("name", &body.name);
    let description = body
        .description
        .as_deref()
        .map_or(Ok(String::new()), validate_description);
    validate::collect(vec![name.clone().map(drop), description.clone().map(drop)])?;
    let (name, description) = (name?, description?);

    let model = sqlx::query_as::<_, ModelDto>(&format!(
        "INSERT INTO models (id, workspace_id, name, description, calendar, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING {MODEL_COLUMNS}"
    ))
    .bind(Uuid::now_v7())
    .bind(workspace_id)
    .bind(name)
    .bind(description)
    .bind(sqlx::types::Json(default_calendar()))
    .bind(user.id)
    .fetch_one(&state.db)
    .await
    .map_err(map_model_write_error)?;
    Ok((StatusCode::CREATED, Json(model)))
}

#[utoipa::path(
    get,
    path = "/api/v1/models/{id}",
    tag = "models",
    params(("id" = Uuid, Path, description = "The model's id")),
    responses(
        (status = 200, description = "The model", body = ModelDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
    )
)]
pub(crate) async fn get_model(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<Uuid>,
) -> AppResult<Json<ModelDto>> {
    let workspace_id = model_workspace(&state.db, id).await?;
    require_workspace_role(&state.db, &user, workspace_id, WorkspaceRole::Viewer).await?;
    let model = sqlx::query_as::<_, ModelDto>(&format!(
        "SELECT {MODEL_COLUMNS}
         FROM models
         WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(model))
}

#[utoipa::path(
    patch,
    path = "/api/v1/models/{id}",
    tag = "models",
    params(("id" = Uuid, Path, description = "The model's id")),
    request_body = UpdateModelRequest,
    responses(
        (status = 200, description = "The updated model", body = ModelDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
        (status = 409, description = "A model with that name already exists in the workspace (model.name_taken)"),
        (status = 422, description = "Some fields are invalid (validation)"),
    )
)]
pub(crate) async fn update_model(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<UpdateModelRequest>,
) -> AppResult<Json<ModelDto>> {
    let workspace_id = model_workspace(&state.db, id).await?;
    require_workspace_role(&state.db, &user, workspace_id, WorkspaceRole::Builder).await?;
    let name = body
        .name
        .as_deref()
        .map(|raw| validate::entity_name("name", raw))
        .transpose();
    let description = body
        .description
        .as_deref()
        .map(validate_description)
        .transpose();
    validate::collect(vec![name.clone().map(drop), description.clone().map(drop)])?;
    let (name, description) = (name?, description?);

    let model = sqlx::query_as::<_, ModelDto>(&format!(
        "UPDATE models
         SET name = COALESCE($2, name),
             description = COALESCE($3, description),
             mode = COALESCE($4, mode),
             updated_at = now()
         WHERE id = $1
         RETURNING {MODEL_COLUMNS}"
    ))
    .bind(id)
    .bind(name)
    .bind(description)
    .bind(body.mode)
    .fetch_one(&state.db)
    .await
    .map_err(map_model_write_error)?;
    Ok(Json(model))
}

#[utoipa::path(
    delete,
    path = "/api/v1/models/{id}",
    tag = "models",
    params(("id" = Uuid, Path, description = "The model's id")),
    responses(
        (status = 204, description = "The model was deleted"),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
    )
)]
pub(crate) async fn delete_model(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<Uuid>,
) -> AppResult<StatusCode> {
    let workspace_id = model_workspace(&state.db, id).await?;
    require_workspace_role(&state.db, &user, workspace_id, WorkspaceRole::Builder).await?;
    let deleted = sqlx::query("DELETE FROM models WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{Violation, database_error};

    #[test]
    fn model_write_maps_foreign_key_violation_to_not_found() {
        // The workspace was deleted after the caller was authorized for it.
        assert!(matches!(
            map_model_write_error(database_error(Violation::ForeignKey)),
            AppError::NotFound
        ));
    }
}
