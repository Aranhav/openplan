//! The cells of a model over HTTP: writing the cells of input line items, reading cells at any
//! level of their dimensions, and the history of a cell. Reading needs the Viewer role and
//! writing the Planner role, in a model in production mode too, since planning goes on there.
//!
//! A write is one batch for the model's actor: the edits of each line item become one engine
//! command, and either all of them are stored or none. A cell has one history whichever way the
//! case of its period labels is written, because the labels are written the way the calendar
//! does before they are stored.

use std::collections::HashMap;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, FromRequestParts, State},
    http::request::Parts,
    routing::{get, post},
};
use chrono::{DateTime, NaiveDate, Utc};
use openplan_engine::{
    CellEdit, CellIssue, Command, CoordToken, EngineError, ItemId, LineItemId,
    MAX_MODULE_DIMENSIONS, Model, TimeLevel, Value,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    actor::ModelHandle,
    app::AppState,
    auth::CurrentUser,
    authz::WorkspaceRole,
    engine_store::{self, CellHistory, cell_key},
    error::{AppError, AppResult, FieldError},
    extract::{ApiJson, ApiPath, ApiQuery, Capped},
    structure_api::{ProdLock, Viewer, handle_for},
    structure_dto::TimeLevelDto,
};

/// The most edits one write takes.
const MAX_EDITS: usize = 100_000;
/// The most cells one read takes.
const MAX_CELLS: usize = 10_000;
/// The most coordinates a cell has, one for each dimension of its line item, which no module has
/// more of. A request is read into memory before it can be checked against the line item, and a
/// coordinate takes some 10 times the bytes it is written in.
const MAX_COORDS: usize = MAX_MODULE_DIMENSIONS;
/// The most changes the history of a cell lists.
const HISTORY_LIMIT: i64 = 100;
/// The most problems of a request that an error lists.
const MAX_PROBLEMS: usize = 100;
/// How large the body of a write may be. The 2 MiB that other requests are limited to would stop
/// a write well short of its 100,000 edits, which come to about 30 MiB.
const WRITE_BODY_LIMIT: usize = 32 << 20;
/// How large the body of a read may be. Ten thousand cells of five dimensions come to about the
/// 2 MiB that other requests are limited to.
const READ_BODY_LIMIT: usize = 8 << 20;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/models/{id}/cells",
            post(write_cells).layer(DefaultBodyLimit::max(WRITE_BODY_LIMIT)),
        )
        .route(
            "/models/{id}/cells/read",
            post(read_cells).layer(DefaultBodyLimit::max(READ_BODY_LIMIT)),
        )
        .route("/models/{id}/cells/history", get(cell_history))
}

/// The value of a cell, tagged with its type in `t`. A date, an item or a period that is not set
/// is `null`.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(tag = "t", content = "v", rename_all = "snake_case")]
pub enum ValueDto {
    Number(f64),
    Boolean(bool),
    Text(String),
    /// A day.
    Date(Option<NaiveDate>),
    /// The id of an item of the list the line item is formatted as.
    Item(Option<Uuid>),
    /// A period of the calendar: its level and its position among the periods of that level,
    /// counted from the start of the calendar.
    Period(Option<(TimeLevelDto, u32)>),
}

impl From<&Value> for ValueDto {
    fn from(value: &Value) -> Self {
        match value {
            Value::Number(number) => ValueDto::Number(*number),
            Value::Boolean(flag) => ValueDto::Boolean(*flag),
            Value::Text(text) => ValueDto::Text(text.to_string()),
            Value::Date(date) => ValueDto::Date(*date),
            Value::Item(item) => ValueDto::Item(item.map(|item| item.0)),
            Value::Period(period) => {
                ValueDto::Period(period.map(|(level, index)| (level.into(), index)))
            }
        }
    }
}

impl From<ValueDto> for Value {
    fn from(value: ValueDto) -> Self {
        match value {
            ValueDto::Number(number) => Value::Number(number),
            ValueDto::Boolean(flag) => Value::Boolean(flag),
            ValueDto::Text(text) => Value::Text(text.into()),
            ValueDto::Date(date) => Value::Date(date),
            ValueDto::Item(item) => Value::Item(item.map(ItemId)),
            ValueDto::Period(period) => {
                Value::Period(period.map(|(level, index)| (TimeLevel::from(level), index)))
            }
        }
    }
}

/// One cell to write.
#[derive(Deserialize, ToSchema)]
pub struct CellEditDto {
    /// The input line item the cell belongs to.
    line_item_id: Uuid,
    /// One token for each dimension of the line item, in the order the cells are laid out: the
    /// list and subset dimensions first, then Time, then Versions. An item id for a list or
    /// subset, a period label such as `Jan 26` for Time, and a version id for Versions.
    ///
    /// At most 16.
    #[schema(value_type = Vec<String>)]
    coords: Capped<CoordToken, MAX_COORDS>,
    value: ValueDto,
}

#[derive(Deserialize, ToSchema)]
pub struct WriteCellsRequest {
    /// At most 100,000 cells. A cell edited twice takes the value of its last edit. The body
    /// may be up to 32 MiB, and only the first 100,000 edits of one that has more are read.
    #[schema(value_type = Vec<CellEditDto>)]
    edits: Capped<CellEditDto, MAX_EDITS>,
}

#[derive(Serialize, ToSchema)]
pub struct WriteCellsResponse {
    /// The sequence number of the change in the model's change log.
    seq: i64,
    /// The line items whose cells changed: those that were written and those calculated again.
    changed_line_item_ids: Vec<Uuid>,
}

#[derive(Deserialize, ToSchema)]
pub struct ReadCellsRequest {
    line_item_id: Uuid,
    /// At most 10,000 cells, each with one token for each dimension of the line item. A list or
    /// subset dimension takes an item id, which reads the cell itself, an item of a list above
    /// it, which reads the total of the items below it, or `"top"`, the total of all of them. A
    /// Time dimension takes a period label at its level or a coarser one, whatever the case. A
    /// Versions dimension takes a version id. A cell has at most 16 coordinates.
    #[schema(value_type = Vec<Vec<String>>)]
    cells: Capped<Capped<CoordToken, MAX_COORDS>, MAX_CELLS>,
}

#[derive(Serialize, ToSchema)]
pub struct ReadCellsResponse {
    /// The value of each cell asked for, in the same order.
    values: Vec<ValueDto>,
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct HistoryQuery {
    /// The line item the cell belongs to.
    line_item_id: Uuid,
    /// The coordinates of the cell, one for each dimension of the line item, joined by `|`: an
    /// item id or version id, or a period label, whatever the case. Empty for a line item
    /// without dimensions.
    cell_key: String,
}

/// The user who made a change.
#[derive(Serialize, ToSchema)]
pub struct ChangedByDto {
    id: Uuid,
    name: String,
}

/// A change of one cell.
#[derive(Serialize, ToSchema)]
pub struct CellChangeDto {
    at: DateTime<Utc>,
    /// None when the user is gone.
    user: Option<ChangedByDto>,
    /// The value the cell had before.
    old: ValueDto,
    new: ValueDto,
}

impl From<CellHistory> for CellChangeDto {
    fn from(change: CellHistory) -> Self {
        CellChangeDto {
            at: change.at,
            user: change.user.map(|(id, name)| ChangedByDto { id, name }),
            old: (&change.old).into(),
            new: (&change.new).into(),
        }
    }
}

/// The caller and the actor of the model, for a caller who may plan in the model, whatever its
/// mode. It is taken from the head of the request, ahead of the body, so that a caller who may
/// not plan is refused without the body, which may be 32 MiB, being read.
pub(crate) struct Planner {
    user: CurrentUser,
    handle: ModelHandle,
}

impl FromRequestParts<AppState> for Planner {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Planner> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        let ApiPath(model_id) = ApiPath::<Uuid>::from_request_parts(parts, state).await?;
        let handle = handle_for(
            state,
            &user,
            model_id,
            WorkspaceRole::Planner,
            ProdLock::Ignore,
        )
        .await?;
        Ok(Planner { user, handle })
    }
}

fn too_many(field: &str, message: &str) -> AppError {
    AppError::Validation(vec![FieldError {
        field: field.to_string(),
        message: message.to_string(),
    }])
}

fn too_many_coordinates() -> String {
    format!("A cell has at most {MAX_COORDS} coordinates.")
}

fn missing_line_item(field: &str) -> FieldError {
    FieldError {
        field: field.to_string(),
        message: "The line item does not exist.".to_string(),
    }
}

/// `problems`, or the first 100 of them and one more, for `field`, that counts the rest.
fn capped(mut problems: Vec<FieldError>, field: &str) -> Vec<FieldError> {
    if problems.len() > MAX_PROBLEMS {
        let more = problems.len() - MAX_PROBLEMS;
        problems.truncate(MAX_PROBLEMS);
        problems.push(FieldError {
            field: field.to_string(),
            message: format!("…and {more} more."),
        });
    }
    problems
}

/// The edits of one line item, with the position of each in the request.
struct Group {
    line_item: LineItemId,
    requests: Vec<usize>,
    coords: Vec<Vec<CoordToken>>,
    values: Vec<ValueDto>,
}

/// The commands that write `edits` into `model`: one `SetCells` for each line item, in the order
/// the line items first appear, with the edits of each in the order they were sent and the
/// period labels written the way the calendar writes them. Each is checked, and the first that
/// is not valid fails the request with its edits named by their position in the request.
fn write_commands(model: &Model, edits: Vec<CellEditDto>) -> AppResult<Vec<Command>> {
    if let Some(index) = edits.iter().position(|edit| edit.coords.is_over()) {
        return Err(AppError::Engine(EngineError::InvalidCoordinate {
            message: too_many_coordinates(),
            index: Some(index),
        }));
    }
    let structure = model.structure();
    let missing: Vec<FieldError> = edits
        .iter()
        .enumerate()
        .filter(|(_, edit)| structure.line_item(LineItemId(edit.line_item_id)).is_none())
        .map(|(index, _)| missing_line_item(&format!("edits[{index}].line_item_id")))
        .collect();
    if !missing.is_empty() {
        return Err(AppError::MissingReferences(capped(missing, "edits")));
    }

    let mut position: HashMap<LineItemId, usize> = HashMap::new();
    let mut groups: Vec<Group> = Vec::new();
    for (request, edit) in edits.into_iter().enumerate() {
        let line_item = LineItemId(edit.line_item_id);
        let group = *position.entry(line_item).or_insert_with(|| {
            groups.push(Group {
                line_item,
                requests: Vec::new(),
                coords: Vec::new(),
                values: Vec::new(),
            });
            groups.len() - 1
        });
        let group = &mut groups[group];
        group.requests.push(request);
        group.coords.push(edit.coords.into_vec());
        group.values.push(edit.value);
    }
    groups
        .into_iter()
        .map(|group| {
            let coords = model.canonical_coords(group.line_item, &group.coords)?;
            let edits: Vec<CellEdit> = coords
                .into_iter()
                .zip(group.values)
                .map(|(coords, value)| CellEdit {
                    coords,
                    value: value.into(),
                })
                .collect();
            model
                .check_cells(group.line_item, &edits)
                .map_err(|error| located(error, &group.requests))?;
            Ok(Command::SetCells {
                line_item: group.line_item,
                edits,
            })
        })
        .collect()
}

/// An engine error about the edits of one line item, as an error about the request: the engine
/// numbers the edits of a line item from 0, and `requests[i]` is the position in the request of
/// the `i`th.
fn located(error: EngineError, requests: &[usize]) -> AppError {
    let request = |edit: usize| requests.get(edit).copied().unwrap_or(edit);
    match error {
        EngineError::InvalidValue { cells } => {
            let detail = match cells.len() {
                1 => "1 edit has an invalid value.".to_string(),
                count => format!("{count} edits have invalid values."),
            };
            let problems = cells
                .into_iter()
                .map(|CellIssue { index, message }| FieldError {
                    field: format!("edits[{}]", request(index)),
                    message,
                })
                .collect();
            AppError::Unprocessable {
                code: "cells.invalid_value",
                detail,
                errors: capped(problems, "edits"),
            }
        }
        EngineError::InvalidCoordinate { message, index } => {
            AppError::Engine(EngineError::InvalidCoordinate {
                message,
                index: index.map(request),
            })
        }
        other => other.into(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/models/{id}/cells",
    tag = "cells",
    params(("id" = Uuid, Path, description = "The model's id")),
    request_body = WriteCellsRequest,
    responses(
        (status = 200, description = "The cells were written and what depends on them was calculated again", body = WriteCellsResponse),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace planner (auth.forbidden)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
        (status = 422, description = "More than 100,000 edits (validation), a line item that does not exist (structure.invalid), a coordinate that fits no cell or an edit with more than 16 coordinates (cells.invalid_coordinate), a calculated line item (cells.not_input), or a value that does not fit its cell (cells.invalid_value; `errors` lists up to 100 edits as `edits[i]`, i being the position in the request). Only the first line item with invalid edits is reported. Nothing is written."),
        (status = 413, description = "The body is more than 32 MiB (payload_too_large)"),
    )
)]
pub(crate) async fn write_cells(
    Planner { user, handle }: Planner,
    ApiJson(body): ApiJson<WriteCellsRequest>,
) -> AppResult<Json<WriteCellsResponse>> {
    if body.edits.is_over() {
        return Err(too_many("edits", "Send at most 100,000 edits at a time."));
    }
    let edits = body.edits.into_vec();
    // The commands are made in the actor, from the model they are applied to.
    let outcome = handle
        .apply_with(user.id, move |model| write_commands(model, edits))
        .await?;
    Ok(Json(WriteCellsResponse {
        seq: outcome.seq,
        changed_line_item_ids: outcome
            .change_set
            .changed_line_items
            .iter()
            .map(|id| id.0)
            .collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/models/{id}/cells/read",
    tag = "cells",
    params(("id" = Uuid, Path, description = "The model's id")),
    request_body = ReadCellsRequest,
    responses(
        (status = 200, description = "The value of each cell, at the level its tokens name", body = ReadCellsResponse),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
        (status = 413, description = "The body is more than 8 MiB (payload_too_large)"),
        (status = 503, description = "Too many pieces of heavy work are going on and none was free within 10 seconds (server.busy); `Retry-After` says when to try again"),
        (status = 422, description = "More than 10,000 cells (validation), a line item that does not exist (structure.invalid), or a token that fits no level of its dimension or a cell with more than 16 coordinates (cells.invalid_coordinate)"),
    )
)]
pub(crate) async fn read_cells(
    State(state): State<AppState>,
    Viewer { handle, .. }: Viewer,
    ApiJson(body): ApiJson<ReadCellsRequest>,
) -> AppResult<Json<ReadCellsResponse>> {
    if body.cells.is_over() {
        return Err(too_many("cells", "Send at most 10,000 cells at a time."));
    }
    let cells: Vec<Vec<CoordToken>> = body
        .cells
        .into_vec()
        .into_iter()
        .enumerate()
        .map(|(index, coords)| {
            if coords.is_over() {
                return Err(AppError::Engine(EngineError::InvalidCoordinate {
                    message: format!("Cell {index}: {}", too_many_coordinates()),
                    index: None,
                }));
            }
            Ok(coords.into_vec())
        })
        .collect::<AppResult<_>>()?;
    let model = handle.snapshot();
    let line_item = LineItemId(body.line_item_id);
    if model.structure().line_item(line_item).is_none() {
        return Err(AppError::MissingReferences(vec![missing_line_item(
            "line_item_id",
        )]));
    }
    // Rolling up a large line item for the first time can take a while.
    let permit = state.work.permit().await?;
    let values = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        model.read(line_item, &cells)
    })
    .await
    .map_err(|error| AppError::Internal(error.into()))??;
    Ok(Json(ReadCellsResponse {
        values: values.iter().map(ValueDto::from).collect(),
    }))
}

/// The key under which the change log keeps the cell that `key` names: the same coordinates with
/// every period label written the way the calendar writes it. A key that fits no cell of the line
/// item, such as that of a cell whose item was deleted, is looked up as it is.
fn canonical_key(model: &Model, line_item: LineItemId, key: &str) -> AppResult<String> {
    let tokens: Vec<CoordToken> = if key.is_empty() {
        Vec::new()
    } else {
        key.split('|').map(token_of).collect()
    };
    let canonical = model
        .canonical_coords(line_item, std::slice::from_ref(&tokens))?
        .into_iter()
        .next()
        .unwrap_or(tokens);
    Ok(cell_key(&canonical))
}

/// The token a part of a cell key stands for: an id, or else a period label.
fn token_of(part: &str) -> CoordToken {
    Uuid::parse_str(part).map_or_else(
        |_| CoordToken::Period(part.to_string()),
        |id| CoordToken::Item(ItemId(id)),
    )
}

#[utoipa::path(
    get,
    path = "/api/v1/models/{id}/cells/history",
    tag = "cells",
    params(("id" = Uuid, Path, description = "The model's id"), HistoryQuery),
    responses(
        (status = 200, description = "The last 100 changes of the cell, newest first. A write that left the cell as it was is not a change.", body = [CellChangeDto]),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
        (status = 422, description = "A query parameter is missing (validation) or the line item does not exist (structure.invalid)"),
    )
)]
pub(crate) async fn cell_history(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(model_id): ApiPath<Uuid>,
    ApiQuery(query): ApiQuery<HistoryQuery>,
) -> AppResult<Json<Vec<CellChangeDto>>> {
    let handle = handle_for(
        &state,
        &user,
        model_id,
        WorkspaceRole::Viewer,
        ProdLock::Ignore,
    )
    .await?;
    let model = handle.snapshot();
    let line_item = LineItemId(query.line_item_id);
    if model.structure().line_item(line_item).is_none() {
        return Err(AppError::MissingReferences(vec![missing_line_item(
            "line_item_id",
        )]));
    }
    let key = canonical_key(&model, line_item, &query.cell_key)?;
    let changes =
        engine_store::cell_history(&state.db, model_id, line_item, &key, HISTORY_LIMIT).await?;
    Ok(Json(changes.into_iter().map(CellChangeDto::from).collect()))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn values_serialize_exactly_as_the_engine_writes_them_and_read_back() {
        let values = [
            Value::Number(1.5),
            Value::Boolean(true),
            Value::Text(Arc::from("Ship it")),
            Value::Date(NaiveDate::from_ymd_opt(2026, 3, 15)),
            Value::Date(None),
            Value::Item(Some(ItemId::new())),
            Value::Item(None),
            Value::Period(Some((TimeLevel::HalfYear, 3))),
            Value::Period(None),
        ];
        for value in values {
            let written = serde_json::to_value(&value).unwrap();

            assert_eq!(
                serde_json::to_value(ValueDto::from(&value)).unwrap(),
                written
            );
            let read: ValueDto = serde_json::from_value(written).unwrap();
            assert_eq!(Value::from(read), value);
        }
    }

    #[test]
    fn a_part_of_a_cell_key_is_an_id_or_a_period_label() {
        let id = Uuid::now_v7();

        assert_eq!(token_of(&id.to_string()), CoordToken::Item(ItemId(id)));
        assert_eq!(token_of("jan 26"), CoordToken::Period("jan 26".to_string()));
    }
}
