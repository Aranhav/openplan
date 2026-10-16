//! Saved views of a module over HTTP: a name and the definition of a grid, which a builder saves
//! and everybody who may read the model lists and opens. Reading needs the Viewer role, changing
//! needs the Builder role. Views are not structure, so the production lock does not apply to them.
//!
//! A definition is stored as it was sent, and it is checked against the module's structure when
//! it is read: what the module no longer has (a member, a line item, a dimension) is taken out, or
//! the axes are put back to the module's default pivot when its dimensions have changed. The
//! stored row is not rewritten, so the next save stores what the client sends.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ops::RangeInclusive,
};

use axum::{
    Json, Router,
    extract::{FromRequestParts, State},
    http::{StatusCode, request::Parts},
    routing::{get, patch},
};
use chrono::{DateTime, Utc};
use openplan_engine::{AxisSpec, Model, Module, ModuleId, ViewDim, view};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    actor::ModelHandle,
    app::AppState,
    auth::CurrentUser,
    authz::WorkspaceRole,
    error::{AppError, AppResult, FieldError},
    extract::{ApiJson, ApiPath, Capped},
    structure_api::{ProdLock, handle_for},
    validate,
    view_dto::{
        MAX_FILTERS, MAX_LINE_ITEMS, MAX_MEMBERS, MemberRefDto, PageSelectionDto, RowFilterDto,
        ViewDimDto,
    },
};

/// The most views a module has.
const MAX_VIEWS: i64 = 200;
/// The most conditional formats a view has.
const MAX_CONDITIONAL_FORMATS: usize = 50;
/// The most column widths a view keeps.
const MAX_COLUMN_WIDTHS: usize = 1_000;
/// The narrowest and the widest column a view may give, in pixels.
const COLUMN_WIDTHS: RangeInclusive<u16> = 24..=2_000;
/// The index that keeps the names of the views of a module apart.
const NAME_INDEX: &str = "views_module_name_key";

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/models/{id}/modules/{module_id}/views",
            get(list_views).post(create_view),
        )
        .route(
            "/models/{id}/views/{view_id}",
            patch(update_view).delete(delete_view),
        )
}

/// The colour a conditional format shows its cells in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FormatColor {
    Red,
    Amber,
    Green,
    Blue,
    Muted,
}

/// How a conditional format compares the values of its line items: with `value`, with `value` and
/// `value2` as the two ends of a range, or without a value at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FormatOp {
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    Between,
    Negative,
    Positive,
    Blank,
}

/// How a cell that a conditional format matches is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct FormatStyle {
    color: FormatColor,
    bold: bool,
}

/// A rule that styles the cells of some line items whose values match it. Of the rules that match
/// a cell, the first one applies.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ConditionalFormat {
    name: String,
    line_item_ids: Vec<Uuid>,
    op: FormatOp,
    value: Option<f64>,
    value2: Option<f64>,
    style: FormatStyle,
}

fn yes() -> bool {
    true
}

/// What a view shows of a module: the same as a query of the grid, with the same limits, less
/// the window.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ViewDefinition {
    rows: Vec<ViewDimDto>,
    columns: Vec<ViewDimDto>,
    #[serde(default)]
    pages: Vec<PageSelectionDto>,
    #[serde(default = "yes")]
    show_summaries: bool,
    /// At most 5,000.
    #[serde(default)]
    #[schema(value_type = Vec<MemberRefDto>)]
    collapsed: Capped<MemberRefDto, MAX_MEMBERS>,
    /// At most 5,000.
    #[serde(default)]
    #[schema(value_type = Vec<MemberRefDto>)]
    hidden: Capped<MemberRefDto, MAX_MEMBERS>,
    /// At most 10.
    #[serde(default)]
    #[schema(value_type = Vec<RowFilterDto>)]
    filters: Capped<RowFilterDto, MAX_FILTERS>,
    /// The line items to show and their order; all of them, by ordinal, when absent. At most
    /// 1,000.
    #[serde(default)]
    #[schema(value_type = Option<Vec<Uuid>>)]
    line_items: Option<Capped<Uuid, MAX_LINE_ITEMS>>,
    /// At most 50.
    #[serde(default)]
    #[schema(value_type = Vec<ConditionalFormat>)]
    conditional_formats: Capped<ConditionalFormat, MAX_CONDITIONAL_FORMATS>,
    /// The width of each column in pixels, by the joined keys of its members. At most 1,000
    /// entries, each from 24 to 2,000.
    #[serde(default)]
    column_widths: BTreeMap<String, u16>,
}

/// A 422 that names a field of the definition.
fn limit(field: &str, message: &str) -> AppError {
    AppError::Validation(vec![FieldError {
        field: format!("definition.{field}"),
        message: message.to_string(),
    }])
}

impl ViewDefinition {
    /// The first limit the definition breaks, named by its field.
    fn check_limits(&self) -> AppResult<()> {
        if self.filters.is_over() {
            return Err(limit("filters", "Send at most 10 filters."));
        }
        if self.line_items.as_ref().is_some_and(Capped::is_over) {
            return Err(limit("line_items", "Send at most 1,000 line items."));
        }
        if self.collapsed.is_over() {
            return Err(limit("collapsed", "Send at most 5,000 collapsed members."));
        }
        if self.hidden.is_over() {
            return Err(limit("hidden", "Send at most 5,000 hidden members."));
        }
        if self.conditional_formats.is_over() {
            return Err(limit(
                "conditional_formats",
                "Send at most 50 conditional formats.",
            ));
        }
        if self.column_widths.len() > MAX_COLUMN_WIDTHS {
            return Err(limit("column_widths", "Send at most 1,000 column widths."));
        }
        if self
            .column_widths
            .values()
            .any(|width| !COLUMN_WIDTHS.contains(width))
        {
            return Err(limit(
                "column_widths",
                "Column widths are from 24 to 2,000 pixels.",
            ));
        }
        Ok(())
    }
}

/// The body of a request to save a view.
#[derive(Deserialize, ToSchema)]
pub struct CreateViewRequest {
    name: String,
    definition: ViewDefinition,
    /// False when absent.
    is_default: Option<bool>,
}

/// The parts of a view to change; the ones that are absent stay as they are.
#[derive(Deserialize, ToSchema)]
pub struct UpdateViewRequest {
    name: Option<String>,
    definition: Option<ViewDefinition>,
    is_default: Option<bool>,
}

/// A saved view, as it is returned.
#[derive(Serialize, ToSchema)]
pub struct ViewDto {
    id: Uuid,
    module_id: Uuid,
    name: String,
    definition: ViewDefinition,
    /// Whether the view opens first among the views of its module; a module has at most one.
    is_default: bool,
    /// The user who saved the view; none once that user is deleted.
    created_by: Option<Uuid>,
    updated_at: DateTime<Utc>,
    /// Whether the definition returned differs from the stored one, because the module no longer
    /// has something it names. Only a list says so; the stored definition is kept until the view
    /// is saved again.
    pruned: bool,
}

/// A view as the database holds it.
#[derive(sqlx::FromRow)]
struct ViewRow {
    id: Uuid,
    module_id: Uuid,
    name: String,
    definition: sqlx::types::Json<ViewDefinition>,
    is_default: bool,
    created_by: Option<Uuid>,
    updated_at: DateTime<Utc>,
}

impl ViewRow {
    /// The view as it is returned. A view that is listed is pruned against its module.
    fn into_dto(self, known: Option<&Known>) -> ViewDto {
        let (definition, pruned) = match known {
            Some(known) => known.prune(self.definition.0),
            None => (self.definition.0, false),
        };
        ViewDto {
            id: self.id,
            module_id: self.module_id,
            name: self.name,
            definition,
            is_default: self.is_default,
            created_by: self.created_by,
            updated_at: self.updated_at,
            pruned,
        }
    }
}

/// The dimensions of a module, and the members of each, as the engine lists them.
struct Known {
    /// The dimensions of the module, its axes and then its line items.
    dims: Vec<ViewDim>,
    /// The line items of the module.
    line_items: HashSet<Uuid>,
    /// The keys of the members of each dimension but line items.
    members: HashMap<ViewDim, HashSet<String>>,
    /// The first member of each dimension but line items, in the order a view shows them.
    first: HashMap<ViewDim, String>,
    /// Every key that names a member of the module, of any dimension.
    keys: HashSet<String>,
}

fn module_dims(module: &Module) -> Vec<ViewDim> {
    module
        .axes
        .iter()
        .map(|axis| match axis {
            AxisSpec::List { list } => ViewDim::List { list: *list },
            AxisSpec::Subset { subset } => ViewDim::Subset { subset: *subset },
            AxisSpec::Time { .. } => ViewDim::Time,
            AxisSpec::Versions => ViewDim::Versions,
        })
        .chain([ViewDim::LineItems])
        .collect()
}

impl Known {
    fn new(model: &Model, module: ModuleId) -> AppResult<Known> {
        let structure = model.structure();
        let module = structure.module(module).ok_or(AppError::NotFound)?;
        let dims = module_dims(module);
        let line_items: HashSet<Uuid> = structure
            .line_items_in(module.id)
            .map(|line_item| line_item.id.0)
            .collect();
        let mut keys: HashSet<String> = line_items.iter().map(Uuid::to_string).collect();
        let mut members = HashMap::new();
        let mut first = HashMap::new();
        for dim in dims.iter().filter(|dim| **dim != ViewDim::LineItems) {
            let listed = view::members(model, module.id, dim, true)?;
            if let Some(member) = listed.first() {
                first.insert(dim.clone(), member.key.clone());
            }
            let of_dim: HashSet<String> = listed.into_iter().map(|member| member.key).collect();
            keys.extend(of_dim.iter().cloned());
            members.insert(dim.clone(), of_dim);
        }
        Ok(Known {
            dims,
            line_items,
            members,
            first,
            keys,
        })
    }

    /// The definition as the module now has it, and whether that differs from the stored one.
    fn prune(&self, definition: ViewDefinition) -> (ViewDefinition, bool) {
        let ViewDefinition {
            mut rows,
            mut columns,
            mut pages,
            show_summaries,
            collapsed,
            hidden,
            filters,
            line_items,
            conditional_formats,
            column_widths,
        } = definition;
        let mut collapsed = collapsed.into_vec();
        let mut hidden = hidden.into_vec();
        let mut filters = filters.into_vec();
        let conditional_formats = conditional_formats.into_vec();
        let mut line_items = line_items.map(Capped::into_vec);
        let mut changed = false;

        if !self.same_dims(&rows, &columns, &pages) {
            (rows, columns, pages) = self.default_pivot();
            collapsed.clear();
            hidden.clear();
            changed = true;
        }

        if let Some(listed) = line_items.as_mut() {
            let before = listed.len();
            listed.retain(|id| self.line_items.contains(id));
            changed |= listed.len() != before;
        }
        // The members of line items are the ones the view lists, as the grid reads them.
        let listed: HashSet<Uuid> = match &line_items {
            Some(listed) => listed.iter().copied().collect(),
            None => self.line_items.clone(),
        };
        let is_member = |dim: &ViewDimDto, key: &str| self.has_member(dim, key, &listed);

        let before = collapsed.len();
        collapsed.retain(|member| is_member(&member.dim, &member.key));
        changed |= collapsed.len() != before;
        let before = hidden.len();
        hidden.retain(|member| is_member(&member.dim, &member.key));
        changed |= hidden.len() != before;

        for page in &mut pages {
            let stale = page
                .key
                .as_deref()
                .is_some_and(|key| !is_member(&page.dim, key));
            if stale {
                page.key = self.first_key(&ViewDim::from(page.dim.clone()));
                changed = true;
            }
        }

        let before = filters.len();
        filters.retain(|filter| self.line_items.contains(&filter.line_item));
        changed |= filters.len() != before;

        let mut kept_formats = Vec::with_capacity(conditional_formats.len());
        for mut format in conditional_formats {
            let before = format.line_item_ids.len();
            format
                .line_item_ids
                .retain(|id| self.line_items.contains(id));
            let pruned = format.line_item_ids.len() != before;
            changed |= pruned;
            if !(pruned && format.line_item_ids.is_empty()) {
                kept_formats.push(format);
            }
        }

        let before = column_widths.len();
        let column_widths: BTreeMap<String, u16> = column_widths
            .into_iter()
            .filter(|(key, _)| key.split('|').all(|part| self.keys.contains(part)))
            .collect();
        changed |= column_widths.len() != before;

        let definition = ViewDefinition {
            rows,
            columns,
            pages,
            show_summaries,
            collapsed: Capped::from(collapsed),
            hidden: Capped::from(hidden),
            filters: Capped::from(filters),
            line_items: line_items.map(Capped::from),
            conditional_formats: Capped::from(kept_formats),
            column_widths,
        };
        (definition, changed)
    }

    /// Whether the rows, columns and pages of a view name each dimension of the module once.
    fn same_dims(
        &self,
        rows: &[ViewDimDto],
        columns: &[ViewDimDto],
        pages: &[PageSelectionDto],
    ) -> bool {
        let named: Vec<ViewDim> = rows
            .iter()
            .chain(columns)
            .map(|dim| ViewDim::from(dim.clone()))
            .chain(pages.iter().map(|page| ViewDim::from(page.dim.clone())))
            .collect();
        named.len() == self.dims.len() && self.dims.iter().all(|dim| named.contains(dim))
    }

    /// The default pivot of the module: the line items on the rows, the time or else the first list
    /// on the columns, and every other dimension on the pages, each at its first member.
    fn default_pivot(&self) -> (Vec<ViewDimDto>, Vec<ViewDimDto>, Vec<PageSelectionDto>) {
        let column = if self.dims.contains(&ViewDim::Time) {
            Some(ViewDim::Time)
        } else {
            self.dims
                .iter()
                .find(|dim| matches!(dim, ViewDim::List { .. }))
                .cloned()
        };
        let pages = self
            .dims
            .iter()
            .filter(|dim| **dim != ViewDim::LineItems && Some(*dim) != column.as_ref())
            .map(|dim| PageSelectionDto {
                dim: ViewDimDto::from(dim.clone()),
                key: self.first_key(dim),
            })
            .collect();
        let columns = column.into_iter().map(ViewDimDto::from).collect();
        (vec![ViewDimDto::LineItems], columns, pages)
    }

    /// The key of the first member of a dimension. None for a line item, which has no member
    /// here: the grid picks its own default line item for a page without a key.
    fn first_key(&self, dim: &ViewDim) -> Option<String> {
        self.first.get(dim).cloned()
    }

    /// Whether `key` names a member of the dimension: a line item only when it is among `listed`.
    fn has_member(&self, dim: &ViewDimDto, key: &str, listed: &HashSet<Uuid>) -> bool {
        match ViewDim::from(dim.clone()) {
            ViewDim::LineItems => Uuid::parse_str(key).is_ok_and(|id| listed.contains(&id)),
            dim => self
                .members
                .get(&dim)
                .is_some_and(|keys| keys.contains(key)),
        }
    }
}

/// The access of a caller to the views of a model: the caller, the actor of the model, and the
/// model and the second path parameter, which names the module or the view.
pub(crate) struct Access {
    user: CurrentUser,
    handle: ModelHandle,
    model_id: Uuid,
    target: Uuid,
}

/// The access of a caller whose role in the model's workspace is at least `role`. It is taken from
/// the head of the request, so that a caller who may not change or read views is refused before a
/// body is read.
async fn access(parts: &mut Parts, state: &AppState, role: WorkspaceRole) -> AppResult<Access> {
    let user = CurrentUser::from_request_parts(parts, state).await?;
    let ApiPath((model_id, target)) =
        ApiPath::<(Uuid, Uuid)>::from_request_parts(parts, state).await?;
    let handle = handle_for(state, &user, model_id, role, ProdLock::Ignore).await?;
    Ok(Access {
        user,
        handle,
        model_id,
        target,
    })
}

/// The access of a caller who may read the views of a model.
pub(crate) struct Reader(Access);

impl FromRequestParts<AppState> for Reader {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Reader> {
        access(parts, state, WorkspaceRole::Viewer)
            .await
            .map(Reader)
    }
}

/// The access of a caller who may save views of a model.
pub(crate) struct Writer(Access);

impl FromRequestParts<AppState> for Writer {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Writer> {
        access(parts, state, WorkspaceRole::Builder)
            .await
            .map(Writer)
    }
}

/// Runs `work` on a thread that may block, as the grid's heavy work does.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| AppError::Internal(error.into()))?
}

/// Takes the model's row lock for the rest of the transaction, so that the views of a model are
/// changed one at a time: the count of its views, and the one default, are then what the
/// transaction sees.
async fn lock_model(tx: &mut Transaction<'_, Postgres>, model_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT 1 FROM models WHERE id = $1 FOR UPDATE")
        .bind(model_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(())
}

/// Clears the default of the module, except the view `except`.
async fn clear_default(
    tx: &mut Transaction<'_, Postgres>,
    module_id: Uuid,
    except: Option<Uuid>,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE views SET is_default = false, updated_at = now()
         WHERE module_id = $1 AND is_default AND id IS DISTINCT FROM $2",
    )
    .bind(module_id)
    .bind(except)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// A clash with another view's name in the module is `model.name_taken`; a model that is gone
/// while the view was saved is `not_found`.
fn map_write_error(error: sqlx::Error) -> AppError {
    match error {
        sqlx::Error::Database(db_error)
            if db_error.is_unique_violation() && db_error.constraint() == Some(NAME_INDEX) =>
        {
            AppError::Conflict {
                code: "model.name_taken",
                detail: "A view with this name already exists in this module.".into(),
            }
        }
        sqlx::Error::Database(db_error) if db_error.is_foreign_key_violation() => {
            AppError::NotFound
        }
        other => other.into(),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/models/{id}/modules/{module_id}/views",
    tag = "views",
    params(
        ("id" = Uuid, Path, description = "The model's id"),
        ("module_id" = Uuid, Path, description = "The module's id"),
    ),
    responses(
        (status = 200, description = "The views of the module, the default one first and then by name. A view whose definition names what the module no longer has comes back without it, with `pruned` true.", body = [ViewDto]),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 404, description = "No such model or module, or the caller is not a member of the model's workspace (not_found)"),
        (status = 503, description = "Too many pieces of heavy work are going on and none was free within 10 seconds (server.busy); `Retry-After` says when to try again"),
    )
)]
pub(crate) async fn list_views(
    State(state): State<AppState>,
    Reader(access): Reader,
) -> AppResult<Json<Vec<ViewDto>>> {
    let model = access.handle.snapshot();
    let module = ModuleId(access.target);
    if model.structure().module(module).is_none() {
        return Err(AppError::NotFound);
    }
    let rows = sqlx::query_as::<_, ViewRow>(
        "SELECT id, module_id, name, definition, is_default, created_by, updated_at
         FROM views WHERE model_id = $1 AND module_id = $2
         ORDER BY is_default DESC, lower(name)",
    )
    .bind(access.model_id)
    .bind(access.target)
    .fetch_all(&state.db)
    .await?;
    if rows.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let permit = state.work.permit().await?;
    let views: Vec<ViewDto> = blocking(move || {
        let _permit = permit;
        let known = Known::new(&model, module)?;
        Ok(rows
            .into_iter()
            .map(|row| row.into_dto(Some(&known)))
            .collect())
    })
    .await?;
    Ok(Json(views))
}

#[utoipa::path(
    post,
    path = "/api/v1/models/{id}/modules/{module_id}/views",
    tag = "views",
    params(
        ("id" = Uuid, Path, description = "The model's id"),
        ("module_id" = Uuid, Path, description = "The module's id"),
    ),
    request_body = CreateViewRequest,
    responses(
        (status = 201, description = "The view as saved", body = ViewDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model or module, or the caller is not a member of the model's workspace (not_found)"),
        (status = 409, description = "A view of the module has that name (model.name_taken)"),
        (status = 413, description = "The body is more than 2 MiB (payload_too_large)"),
        (status = 422, description = "The name is blank or longer than 80 characters, the module has 200 views already, a field of the definition is invalid or over its limit (validation)"),
    )
)]
pub(crate) async fn create_view(
    State(state): State<AppState>,
    Writer(access): Writer,
    ApiJson(body): ApiJson<CreateViewRequest>,
) -> AppResult<(StatusCode, Json<ViewDto>)> {
    if access
        .handle
        .snapshot()
        .structure()
        .module(ModuleId(access.target))
        .is_none()
    {
        return Err(AppError::NotFound);
    }
    let name = validate::entity_name("name", &body.name)?;
    body.definition.check_limits()?;
    let is_default = body.is_default.unwrap_or(false);

    let mut tx = state.db.begin().await?;
    lock_model(&mut tx, access.model_id).await?;
    let existing: i64 = sqlx::query_scalar("SELECT count(*) FROM views WHERE module_id = $1")
        .bind(access.target)
        .fetch_one(&mut *tx)
        .await?;
    if existing >= MAX_VIEWS {
        return Err(AppError::Validation(vec![FieldError {
            field: "name".into(),
            message: format!("A module can have at most {MAX_VIEWS} views."),
        }]));
    }
    if is_default {
        clear_default(&mut tx, access.target, None).await?;
    }
    let row = sqlx::query_as::<_, ViewRow>(
        "INSERT INTO views (id, model_id, module_id, name, definition, is_default, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, module_id, name, definition, is_default, created_by, updated_at",
    )
    .bind(Uuid::now_v7())
    .bind(access.model_id)
    .bind(access.target)
    .bind(name)
    .bind(sqlx::types::Json(&body.definition))
    .bind(is_default)
    .bind(access.user.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(map_write_error)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row.into_dto(None))))
}

#[utoipa::path(
    patch,
    path = "/api/v1/models/{id}/views/{view_id}",
    tag = "views",
    params(
        ("id" = Uuid, Path, description = "The model's id"),
        ("view_id" = Uuid, Path, description = "The view's id"),
    ),
    request_body = UpdateViewRequest,
    responses(
        (status = 200, description = "The view as saved", body = ViewDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such view in the model, or the caller is not a member of the model's workspace (not_found)"),
        (status = 409, description = "Another view of the module has that name (model.name_taken)"),
        (status = 413, description = "The body is more than 2 MiB (payload_too_large)"),
        (status = 422, description = "The name is blank or longer than 80 characters, or a field of the definition is invalid or over its limit (validation)"),
    )
)]
pub(crate) async fn update_view(
    State(state): State<AppState>,
    Writer(access): Writer,
    ApiJson(body): ApiJson<UpdateViewRequest>,
) -> AppResult<Json<ViewDto>> {
    let name = body
        .name
        .as_deref()
        .map(|raw| validate::entity_name("name", raw))
        .transpose()?;
    if let Some(definition) = &body.definition {
        definition.check_limits()?;
    }

    let mut tx = state.db.begin().await?;
    lock_model(&mut tx, access.model_id).await?;
    let current = sqlx::query_as::<_, ViewRow>(
        "SELECT id, module_id, name, definition, is_default, created_by, updated_at
         FROM views WHERE id = $1 AND model_id = $2",
    )
    .bind(access.target)
    .bind(access.model_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    let is_default = body.is_default.unwrap_or(current.is_default);
    if is_default {
        clear_default(&mut tx, current.module_id, Some(current.id)).await?;
    }
    let name = name.unwrap_or_else(|| current.name.clone());
    let definition = match body.definition {
        Some(definition) => sqlx::types::Json(definition),
        None => current.definition,
    };
    let row = sqlx::query_as::<_, ViewRow>(
        "UPDATE views SET name = $2, definition = $3, is_default = $4, updated_at = now()
         WHERE id = $1
         RETURNING id, module_id, name, definition, is_default, created_by, updated_at",
    )
    .bind(current.id)
    .bind(name)
    .bind(definition)
    .bind(is_default)
    .fetch_one(&mut *tx)
    .await
    .map_err(map_write_error)?;
    tx.commit().await?;
    Ok(Json(row.into_dto(None)))
}

#[utoipa::path(
    delete,
    path = "/api/v1/models/{id}/views/{view_id}",
    tag = "views",
    params(
        ("id" = Uuid, Path, description = "The model's id"),
        ("view_id" = Uuid, Path, description = "The view's id"),
    ),
    responses(
        (status = 204, description = "The view is deleted"),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such view in the model, or the caller is not a member of the model's workspace (not_found)"),
    )
)]
pub(crate) async fn delete_view(
    State(state): State<AppState>,
    Writer(access): Writer,
) -> AppResult<StatusCode> {
    let deleted = sqlx::query("DELETE FROM views WHERE id = $1 AND model_id = $2")
        .bind(access.target)
        .bind(access.model_id)
        .execute(&state.db)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}
