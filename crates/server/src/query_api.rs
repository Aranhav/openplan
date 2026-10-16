//! The grid of a module over HTTP: a window of its pivoted view, and the members of one of its
//! dimensions. Reading needs the Viewer role, and a viewer's cells all come back read-only.
//!
//! Both are taken from the model as of the last change applied, which the answer to a query
//! gives the sequence number of, so that a client can tell which changes of the live channel are
//! in it. The caller is checked before the body is read, and the work is done on a thread that
//! may block, since a filtered view of two million rows takes seconds, and only a few such
//! pieces of work run at once ([`crate::work::Work`]). The rows that pass the filters of a view
//! are kept, so that scrolling the window over a view does not read them again, and a view
//! that is not kept yet is read by one request while the others for it wait.

use axum::{
    Router,
    extract::State,
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
    routing::post,
};
use openplan_engine::{EngineError, ModuleId, view};
use serde::Serialize;
use std::sync::Arc;

use crate::{
    app::AppState,
    authz::WorkspaceRole,
    error::{AppError, AppResult, FieldError},
    extract::ApiJson,
    structure_api::Viewer,
    view_dto::{MembersRequest, MembersResponse, ViewMemberDto, ViewQueryDto, ViewResultDto},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/models/{id}/query", post(query))
        .route("/models/{id}/members", post(members))
}

/// A thing a request names that the model does not have: a 422, since only a path that names
/// nothing is a 404.
fn missing(field: &str, what: &str) -> AppError {
    AppError::MissingReferences(vec![FieldError {
        field: field.to_string(),
        message: format!("The {what} does not exist."),
    }])
}

/// An error of the engine in answering a request as the request's: a thing it names that the
/// model does not have is a 422, as for any body.
fn engine_error(error: EngineError) -> AppError {
    match error {
        EngineError::NotFound { what, .. } => missing("query", what),
        other => other.into(),
    }
}

/// A response with `body`, which is JSON.
fn json_response(body: Vec<u8>) -> Response {
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )],
        body,
    )
        .into_response()
}

/// `value` as JSON.
fn to_json<T: Serialize>(value: &T) -> AppResult<Vec<u8>> {
    serde_json::to_vec(value).map_err(|error| AppError::Internal(error.into()))
}

pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| AppError::Internal(error.into()))?
}

#[utoipa::path(
    post,
    path = "/api/v1/models/{id}/query",
    tag = "view",
    params(("id" = Uuid, Path, description = "The model's id")),
    request_body = ViewQueryDto,
    responses(
        (status = 200, description = "A window of the view, with the sequence number of the model it shows. For a caller who is a viewer every cell is also `readonly`.", body = ViewResultDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
        (status = 413, description = "The body is more than 2 MiB (payload_too_large)"),
        (status = 503, description = "Too many pieces of heavy work are going on and none was free within 10 seconds (server.busy); `Retry-After` says when to try again"),
        (status = 422, description = "More than 10 filters, 1,000 line items, 5,000 collapsed members or 5,000 hidden members (validation); a module, list or line item that does not exist, a dimension that is not on the rows, columns or pages once, a member that does not exist, a window of more than 1,000 rows or 200 columns, a filter that does not fit its line item, a Contains filter on a line item that is not text or a list, or a filtered view of more than 2,000,000 rows (structure.invalid)"),
    )
)]
pub(crate) async fn query(
    State(state): State<AppState>,
    Viewer { handle, role }: Viewer,
    ApiJson(body): ApiJson<ViewQueryDto>,
) -> AppResult<Response> {
    let query = body.into_query()?;
    let (model, seq) = handle.snapshot_seq();
    if model.structure().module(query.module).is_none() {
        return Err(missing("module", "module"));
    }
    let readonly = role == WorkspaceRole::Viewer;
    let cache = handle.passing_cache();
    // A view with filters has its rows kept; one that is not is found by one request, which the
    // others wait for without a permit, and then they find them kept.
    let filtered = !query.filters.is_empty();
    let mut known = filtered.then(|| cache.get(seq, &query)).flatten();
    let mut flight = None;
    if filtered && known.is_none() {
        flight = Some(cache.flight(seq, &query).await);
        known = cache.get(seq, &query);
    }
    let permit = state.work.permit().await?;
    let body = blocking(move || {
        let (_permit, _flight) = (permit, flight);
        let (result, passing) =
            view::query_with(&model, &query, known.as_ref()).map_err(engine_error)?;
        if let Some(passing) = passing
            && known
                .as_ref()
                .is_none_or(|known| !Arc::ptr_eq(known, &passing))
        {
            cache.put(seq, &query, passing);
        }
        to_json(&ViewResultDto::new(result, seq, readonly))
    })
    .await?;
    Ok(json_response(body))
}

#[utoipa::path(
    post,
    path = "/api/v1/models/{id}/members",
    tag = "view",
    params(("id" = Uuid, Path, description = "The model's id")),
    request_body = MembersRequest,
    responses(
        (status = 200, description = "The members of the dimension, in the order a view shows them", body = MembersResponse),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
        (status = 413, description = "The body is more than 2 MiB (payload_too_large)"),
        (status = 503, description = "Too many pieces of heavy work are going on and none was free within 10 seconds (server.busy); `Retry-After` says when to try again"),
        (status = 422, description = "A module or list that does not exist, a dimension the module does not have, or one with more than 100,000 members (structure.invalid)"),
    )
)]
pub(crate) async fn members(
    State(state): State<AppState>,
    Viewer { handle, .. }: Viewer,
    ApiJson(body): ApiJson<MembersRequest>,
) -> AppResult<Response> {
    let model = handle.snapshot();
    let module = ModuleId(body.module_id);
    if model.structure().module(module).is_none() {
        return Err(missing("module_id", "module"));
    }
    let dim = body.dim.into();
    let permit = state.work.permit().await?;
    let body = blocking(move || {
        let _permit = permit;
        let members =
            view::members(&model, module, &dim, body.show_summaries).map_err(engine_error)?;
        to_json(&MembersResponse {
            members: members.into_iter().map(ViewMemberDto::from).collect(),
        })
    })
    .await?;
    Ok(json_response(body))
}
