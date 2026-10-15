//! Modules, line items and formulas over HTTP. Reading needs the Viewer role; changing modules and
//! line items needs the Builder role and a model in development mode, since production models
//! change through ALM sync. Each change is one engine command applied through the model's actor,
//! which stores it before the response is sent.
//!
//! Formulas are checked by the engine whenever a line item is created or changed, so a formula
//! that does not compile, or that makes a circular reference or does not fit the dimensions of
//! the line items it reads, is a 422 with the problems in `formula_errors`. The editor asks
//! beforehand with `POST /formula/check`, which never changes the model.

use std::collections::{HashMap, HashSet};

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, patch, post},
};
use openplan_engine::{
    AxisSpec, Command, Completion, CompletionKind, Format, LineItem, LineItemId, LineItemPatch,
    ListId, Model, ModuleId, Structure, SummaryMethod, TimeScale, VersionsScope, functions,
};
use serde::{Deserialize, Deserializer, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    actor::ModelHandle,
    app::AppState,
    auth::CurrentUser,
    authz::{WorkspaceRole, require_workspace_role},
    error::{AppError, AppResult, FieldError, FormulaProblem},
    extract::{ApiJson, ApiPath, ApiQuery},
    structure_api::{model_row, read_handle, write_handle},
    structure_dto::{
        AxisDto, FormatDto, LineItemDto, ModuleDto, NumberUnitDto, SummaryMethodDto, TimeScaleDto,
        ValueTypeDto, VersionsScopeDto,
    },
    validate,
};

/// How many completions the editor is offered at most.
const MAX_COMPLETIONS: usize = 50;
/// The most decimals a number format shows.
const MAX_DECIMALS: u8 = 10;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/models/{id}/modules", post(create_module))
        .route(
            "/models/{id}/modules/{module_id}",
            patch(update_module).delete(delete_module),
        )
        .route(
            "/models/{id}/modules/{module_id}/line-items",
            post(create_line_item),
        )
        .route("/models/{id}/line-items/reorder", post(reorder_line_items))
        .route(
            "/models/{id}/line-items/{line_item_id}",
            patch(update_line_item).delete(delete_line_item),
        )
        .route("/models/{id}/formula/check", post(check_formula))
        .route("/models/{id}/formula/completions", get(completions))
        .route("/formula/functions", get(functions_reference))
}

/// Reads a field that may also be sent as `null`: absent is `None`, `null` is `Some(None)` and a
/// value is `Some(Some(value))`.
fn nullable<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize, ToSchema)]
pub struct CreateModuleRequest {
    name: String,
    axes: Vec<AxisDto>,
    /// The folder label used for navigation; none when absent.
    functional_area: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct UpdateModuleRequest {
    name: Option<String>,
    /// Replaces the dimensions of the module.
    axes: Option<Vec<AxisDto>>,
    functional_area: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct CreateLineItemRequest {
    name: String,
    /// The position among the line items of the module; one after the last when absent.
    ordinal: Option<i32>,
    /// A plain number when absent.
    format: Option<FormatDto>,
    /// Without a formula, or with a blank one, the line item is an input.
    formula: Option<String>,
    /// Sum when absent.
    summary: Option<SummaryMethodDto>,
    time_summary: Option<SummaryMethodDto>,
    applies_to: Option<Vec<AxisDto>>,
    /// The module's when absent.
    time_scale: Option<TimeScaleDto>,
    /// The module's when absent.
    versions: Option<VersionsScopeDto>,
    notes: Option<String>,
    code: Option<String>,
    read_access_driver: Option<Uuid>,
    write_access_driver: Option<Uuid>,
}

#[derive(Deserialize, ToSchema)]
pub struct UpdateLineItemRequest {
    name: Option<String>,
    ordinal: Option<i32>,
    format: Option<FormatDto>,
    /// Absent leaves the formula as it is; `null` or a blank formula clears it, which makes the
    /// line item an input.
    #[serde(default, deserialize_with = "nullable")]
    formula: Option<Option<String>>,
    summary: Option<SummaryMethodDto>,
    /// Absent leaves the time summary as it is; `null` clears it.
    #[serde(default, deserialize_with = "nullable")]
    time_summary: Option<Option<SummaryMethodDto>>,
    /// Absent leaves the dimensions as they are; `null` clears them, so that the line item
    /// has those of its module.
    #[serde(default, deserialize_with = "nullable")]
    applies_to: Option<Option<Vec<AxisDto>>>,
    time_scale: Option<TimeScaleDto>,
    versions: Option<VersionsScopeDto>,
    notes: Option<String>,
    /// Absent leaves the code as it is; `null` clears it.
    #[serde(default, deserialize_with = "nullable")]
    code: Option<Option<String>>,
    /// Absent leaves the driver as it is; `null` clears it.
    #[serde(default, deserialize_with = "nullable")]
    read_access_driver: Option<Option<Uuid>>,
    /// Absent leaves the driver as it is; `null` clears it.
    #[serde(default, deserialize_with = "nullable")]
    write_access_driver: Option<Option<Uuid>>,
}

#[derive(Deserialize, ToSchema)]
pub struct ReorderLineItemsRequest {
    module_id: Uuid,
    /// Every line item of the module once, in the order they are to have.
    ids: Vec<Uuid>,
}

#[derive(Deserialize, ToSchema)]
pub struct CheckFormulaRequest {
    /// The line item the formula is for.
    line_item_id: Uuid,
    formula: String,
}

/// What checking a formula found.
#[derive(Serialize, ToSchema)]
pub struct CheckFormulaResponse {
    /// Whether the formula would be accepted.
    ok: bool,
    /// The type of the formula; only when it is accepted.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    #[schema(nullable = false)]
    value_type: Option<ValueTypeDto>,
    /// Everything wrong with the formula; only when it is not accepted.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(nullable = false)]
    errors: Option<Vec<FormulaProblem>>,
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct CompletionsQuery {
    /// The line item the formula is for.
    line_item_id: Uuid,
    /// What has been typed so far, matched without regard to case.
    #[serde(default)]
    prefix: String,
}

/// What kind of thing a completion is.
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CompletionKindDto {
    LineItem,
    List,
    Function,
    Keyword,
}

/// Something the formula editor offers at the cursor.
#[derive(Serialize, ToSchema)]
pub struct CompletionDto {
    /// What to insert: a name as it is written in a formula, quoted when it needs to be.
    label: String,
    kind: CompletionKindDto,
    /// A line of help: the type of a line item, the documentation of a function.
    detail: String,
}

/// A built-in function of the formula language.
#[derive(Serialize, ToSchema)]
pub struct FunctionDto {
    name: String,
    category: String,
    /// The fewest arguments a call takes.
    min_args: usize,
    /// The most arguments a call takes; none when there is no limit.
    max_args: Option<usize>,
    /// One sentence saying what the function does.
    doc: String,
    /// A formula that uses the function.
    example: String,
}

impl From<Completion> for CompletionDto {
    fn from(completion: Completion) -> Self {
        CompletionDto {
            label: completion.label,
            kind: match completion.kind {
                CompletionKind::LineItem => CompletionKindDto::LineItem,
                CompletionKind::List => CompletionKindDto::List,
                CompletionKind::Function => CompletionKindDto::Function,
                CompletionKind::Keyword => CompletionKindDto::Keyword,
            },
            detail: completion.detail,
        }
    }
}

/// A code as the engine keeps it: trimmed, and absent when blank.
fn code_of(raw: String) -> Option<String> {
    Some(raw.trim().to_string()).filter(|code| !code.is_empty())
}

/// A formula as the engine keeps it: absent when blank.
fn formula_of(raw: String) -> Option<String> {
    Some(raw).filter(|formula| !formula.trim().is_empty())
}

fn axes_of(axes: Vec<AxisDto>) -> Vec<AxisSpec> {
    axes.into_iter().map(AxisSpec::from).collect()
}

/// The problems with a number format that do not depend on the model: the currency code is three
/// uppercase letters (ISO 4217) and there are at most ten decimals. Other formats have none.
fn format_checks(format: &FormatDto) -> Vec<Result<(), FieldError>> {
    let FormatDto::Number { decimals, unit, .. } = format else {
        return Vec::new();
    };
    let mut checks = Vec::new();
    if *decimals > u32::from(MAX_DECIMALS) {
        checks.push(Err(FieldError {
            field: "format.decimals".to_string(),
            message: format!("Decimals must be between 0 and {MAX_DECIMALS}."),
        }));
    }
    if let NumberUnitDto::Currency { code } = unit
        && !(code.len() == 3 && code.bytes().all(|byte| byte.is_ascii_uppercase()))
    {
        checks.push(Err(FieldError {
            field: "format.unit.code".to_string(),
            message: "Currency code must be three uppercase letters, such as USD.".to_string(),
        }));
    }
    checks
}

/// The references of a request body to things the model should have. A body that refers to
/// something missing is a 422 that names the fields; only a path that names nothing is a 404.
struct References<'a> {
    structure: &'a Structure,
    missing: Vec<FieldError>,
}

impl<'a> References<'a> {
    fn new(structure: &'a Structure) -> References<'a> {
        References {
            structure,
            missing: Vec::new(),
        }
    }

    fn miss(&mut self, field: String, what: &str) {
        self.missing.push(FieldError {
            field,
            message: format!("The {what} does not exist."),
        });
    }

    fn axes(&mut self, field: &str, axes: &[AxisSpec]) {
        for (index, axis) in axes.iter().enumerate() {
            match axis {
                AxisSpec::List { list } if self.structure.list(*list).is_none() => {
                    self.miss(format!("{field}[{index}].list"), "list");
                }
                AxisSpec::Subset { subset } if self.structure.subset(*subset).is_none() => {
                    self.miss(format!("{field}[{index}].subset"), "subset");
                }
                AxisSpec::Time {
                    range: Some(range), ..
                } if self.structure.time_range(*range).is_none() => {
                    self.miss(format!("{field}[{index}].range"), "time range");
                }
                _ => {}
            }
        }
    }

    fn format(&mut self, format: &Format) {
        if let Format::List { list } = format
            && self.structure.list(*list).is_none()
        {
            self.miss("format.list".to_string(), "list");
        }
    }

    fn line_item(&mut self, field: &str, id: Option<LineItemId>) {
        if let Some(id) = id
            && self.structure.line_item(id).is_none()
        {
            self.miss(field.to_string(), "line item");
        }
    }

    fn summary(&mut self, field: &str, method: &SummaryMethod) {
        if let SummaryMethod::Ratio {
            numerator,
            denominator,
        } = method
        {
            self.line_item(&format!("{field}.numerator"), Some(*numerator));
            self.line_item(&format!("{field}.denominator"), Some(*denominator));
        }
    }

    fn versions(&mut self, scope: &VersionsScope) {
        if let VersionsScope::Only(versions) = scope {
            for (index, version) in versions.iter().enumerate() {
                if self.structure.version(*version).is_none() {
                    self.miss(format!("versions.only[{index}]"), "version");
                }
            }
        }
    }

    fn finish(self) -> AppResult<()> {
        if self.missing.is_empty() {
            Ok(())
        } else {
            Err(AppError::MissingReferences(self.missing))
        }
    }
}

/// The model's actor, for a caller who may build in the model, in production mode too: for what
/// does not change it.
async fn build_handle(
    state: &AppState,
    user: &CurrentUser,
    model_id: Uuid,
) -> AppResult<ModelHandle> {
    let (workspace_id, _) = model_row(&state.db, model_id).await?;
    require_workspace_role(&state.db, user, workspace_id, WorkspaceRole::Builder).await?;
    state.models.get(model_id).await
}

/// The ordinal after the last line item of a module.
fn next_ordinal(structure: &Structure, module: ModuleId) -> i32 {
    structure
        .line_items_in(module)
        .map(|line_item| line_item.ordinal)
        .max()
        .map_or(0, |last| last.saturating_add(1))
}

/// The commands that give the line items of a module the ordinals 0, 1, 2 and so on in the order
/// of `request.ids`, which must list every one of them once.
fn reorder_commands(model: &Model, request: &ReorderLineItemsRequest) -> AppResult<Vec<Command>> {
    let structure = model.structure();
    let module = ModuleId(request.module_id);
    if structure.module(module).is_none() {
        return Err(AppError::MissingReferences(vec![FieldError {
            field: "module_id".to_string(),
            message: "The module does not exist.".to_string(),
        }]));
    }
    let current: HashMap<LineItemId, i32> = structure
        .line_items_in(module)
        .map(|line_item| (line_item.id, line_item.ordinal))
        .collect();
    let strangers: Vec<FieldError> = request
        .ids
        .iter()
        .enumerate()
        .filter(|(_, id)| !current.contains_key(&LineItemId(**id)))
        .map(|(index, _)| FieldError {
            field: format!("ids[{index}]"),
            message: "The line item does not exist in this module.".to_string(),
        })
        .collect();
    if !strangers.is_empty() {
        return Err(AppError::MissingReferences(strangers));
    }
    let distinct: HashSet<&Uuid> = request.ids.iter().collect();
    if distinct.len() != request.ids.len() || request.ids.len() != current.len() {
        return Err(AppError::Validation(vec![FieldError {
            field: "ids".to_string(),
            message: "List every line item of the module once.".to_string(),
        }]));
    }
    Ok(request
        .ids
        .iter()
        .enumerate()
        .filter_map(|(position, id)| {
            let id = LineItemId(*id);
            let ordinal = i32::try_from(position).unwrap_or(i32::MAX);
            (current.get(&id) != Some(&ordinal)).then(|| Command::UpdateLineItem {
                id,
                patch: LineItemPatch {
                    ordinal: Some(ordinal),
                    ..LineItemPatch::default()
                },
            })
        })
        .collect())
}

#[utoipa::path(
    post,
    path = "/api/v1/models/{id}/modules",
    tag = "modules",
    params(("id" = Uuid, Path, description = "The model's id")),
    request_body = CreateModuleRequest,
    responses(
        (status = 201, description = "The module was created", body = ModuleDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
        (status = 409, description = "The model is in production mode (model.production_locked), or the name is taken (structure.name_taken)"),
        (status = 422, description = "Some fields are invalid, or a list, subset or time range of the dimensions does not exist (validation, structure.invalid)"),
    )
)]
pub(crate) async fn create_module(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(model_id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<CreateModuleRequest>,
) -> AppResult<(StatusCode, Json<ModuleDto>)> {
    let handle = write_handle(&state, &user, model_id).await?;
    let name = validate::entity_name("name", &body.name)?;
    let axes = axes_of(body.axes);
    let snapshot = handle.snapshot();
    let mut references = References::new(snapshot.structure());
    references.axes("axes", &axes);
    references.finish()?;

    let id = ModuleId::new();
    handle
        .apply(
            user.id,
            vec![Command::CreateModule {
                id,
                name,
                axes,
                functional_area: body.functional_area.unwrap_or_default(),
            }],
        )
        .await?;
    let model = handle.snapshot();
    let module = model.structure().module(id).ok_or(AppError::NotFound)?;
    Ok((StatusCode::CREATED, Json(ModuleDto::from(module))))
}

#[utoipa::path(
    patch,
    path = "/api/v1/models/{id}/modules/{module_id}",
    tag = "modules",
    params(
        ("id" = Uuid, Path, description = "The model's id"),
        ("module_id" = Uuid, Path, description = "The module's id"),
    ),
    request_body = UpdateModuleRequest,
    responses(
        (status = 200, description = "The updated module", body = ModuleDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model or module, or the caller is not a member of the workspace (not_found)"),
        (status = 409, description = "The model is in production mode (model.production_locked), or the name is taken (structure.name_taken)"),
        (status = 422, description = "Some fields are invalid, a dimension does not exist, or a line item's time scale would be finer than the module's (validation, structure.invalid)"),
    )
)]
pub(crate) async fn update_module(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath((model_id, module_id)): ApiPath<(Uuid, Uuid)>,
    ApiJson(body): ApiJson<UpdateModuleRequest>,
) -> AppResult<Json<ModuleDto>> {
    let handle = write_handle(&state, &user, model_id).await?;
    let id = ModuleId(module_id);
    if handle.snapshot().structure().module(id).is_none() {
        return Err(AppError::NotFound);
    }
    let name = body
        .name
        .as_deref()
        .map(|raw| validate::entity_name("name", raw))
        .transpose()?;
    let axes = body.axes.map(axes_of);
    if let Some(axes) = &axes {
        let snapshot = handle.snapshot();
        let mut references = References::new(snapshot.structure());
        references.axes("axes", axes);
        references.finish()?;
    }

    handle
        .apply(
            user.id,
            vec![Command::UpdateModule {
                id,
                name,
                axes,
                functional_area: body.functional_area,
            }],
        )
        .await?;
    let model = handle.snapshot();
    let module = model.structure().module(id).ok_or(AppError::NotFound)?;
    Ok(Json(ModuleDto::from(module)))
}

#[utoipa::path(
    delete,
    path = "/api/v1/models/{id}/modules/{module_id}",
    tag = "modules",
    params(
        ("id" = Uuid, Path, description = "The model's id"),
        ("module_id" = Uuid, Path, description = "The module's id"),
    ),
    responses(
        (status = 204, description = "The module and its line items were deleted"),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model or module, or the caller is not a member of the workspace (not_found)"),
        (status = 409, description = "The model is in production mode (model.production_locked), or a line item of another module uses one of its line items (structure.in_use)"),
    )
)]
pub(crate) async fn delete_module(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath((model_id, module_id)): ApiPath<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let handle = write_handle(&state, &user, model_id).await?;
    handle
        .apply(
            user.id,
            vec![Command::DeleteModule {
                id: ModuleId(module_id),
            }],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/v1/models/{id}/modules/{module_id}/line-items",
    tag = "modules",
    params(
        ("id" = Uuid, Path, description = "The model's id"),
        ("module_id" = Uuid, Path, description = "The module's id"),
    ),
    request_body = CreateLineItemRequest,
    responses(
        (status = 201, description = "The line item was created", body = LineItemDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model or module, or the caller is not a member of the workspace (not_found)"),
        (status = 409, description = "The model is in production mode (model.production_locked), or the name is taken (structure.name_taken)"),
        (status = 422, description = "Some fields are invalid, something the line item refers to does not exist, or the formula is not valid (validation, structure.invalid, formula.*)"),
    )
)]
pub(crate) async fn create_line_item(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath((model_id, module_id)): ApiPath<(Uuid, Uuid)>,
    ApiJson(body): ApiJson<CreateLineItemRequest>,
) -> AppResult<(StatusCode, Json<LineItemDto>)> {
    let handle = write_handle(&state, &user, model_id).await?;
    let snapshot = handle.snapshot();
    let structure = snapshot.structure();
    let module = ModuleId(module_id);
    // A list's id names the module of its properties, which exists once it has a line item.
    if structure.module(module).is_none() && structure.list(ListId(module_id)).is_none() {
        return Err(AppError::NotFound);
    }
    let name = validate::entity_name("name", &body.name);
    let mut checks = vec![name.clone().map(drop)];
    checks.extend(body.format.iter().flat_map(format_checks));
    validate::collect(checks)?;

    let id = LineItemId::new();
    let line_item = LineItem {
        id,
        module,
        name: name?,
        ordinal: body
            .ordinal
            .unwrap_or_else(|| next_ordinal(structure, module)),
        format: body.format.map_or_else(Format::number, Format::from),
        formula: body.formula.and_then(formula_of),
        summary: body.summary.map_or(SummaryMethod::Sum, SummaryMethod::from),
        time_summary: body.time_summary.map(SummaryMethod::from),
        applies_to: body.applies_to.map(axes_of),
        time_scale: body.time_scale.map_or(TimeScale::Module, TimeScale::from),
        versions: body
            .versions
            .map_or(VersionsScope::Module, VersionsScope::from),
        notes: body.notes.unwrap_or_default(),
        code: body.code.and_then(code_of),
        read_access_driver: body.read_access_driver.map(LineItemId),
        write_access_driver: body.write_access_driver.map(LineItemId),
    };
    let mut references = References::new(structure);
    references.format(&line_item.format);
    references.summary("summary", &line_item.summary);
    if let Some(method) = &line_item.time_summary {
        references.summary("time_summary", method);
    }
    if let Some(axes) = &line_item.applies_to {
        references.axes("applies_to", axes);
    }
    references.versions(&line_item.versions);
    references.line_item("read_access_driver", line_item.read_access_driver);
    references.line_item("write_access_driver", line_item.write_access_driver);
    references.finish()?;

    handle
        .apply(user.id, vec![Command::CreateLineItem(line_item)])
        .await?;
    let model = handle.snapshot();
    let created = model.structure().line_item(id).ok_or(AppError::NotFound)?;
    Ok((StatusCode::CREATED, Json(LineItemDto::from(created))))
}

#[utoipa::path(
    patch,
    path = "/api/v1/models/{id}/line-items/{line_item_id}",
    tag = "modules",
    params(
        ("id" = Uuid, Path, description = "The model's id"),
        ("line_item_id" = Uuid, Path, description = "The line item's id"),
    ),
    request_body = UpdateLineItemRequest,
    responses(
        (status = 200, description = "The updated line item", body = LineItemDto),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model or line item, or the caller is not a member of the workspace (not_found)"),
        (status = 409, description = "The model is in production mode (model.production_locked), or the name is taken (structure.name_taken)"),
        (status = 422, description = "Some fields are invalid, something the line item refers to does not exist, or the formula is not valid (validation, structure.invalid, formula.*)"),
    )
)]
pub(crate) async fn update_line_item(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath((model_id, line_item_id)): ApiPath<(Uuid, Uuid)>,
    ApiJson(body): ApiJson<UpdateLineItemRequest>,
) -> AppResult<Json<LineItemDto>> {
    let handle = write_handle(&state, &user, model_id).await?;
    let id = LineItemId(line_item_id);
    if handle.snapshot().structure().line_item(id).is_none() {
        return Err(AppError::NotFound);
    }
    let name = body
        .name
        .as_deref()
        .map(|raw| validate::entity_name("name", raw));
    let mut checks = vec![name.clone().transpose().map(drop)];
    checks.extend(body.format.iter().flat_map(format_checks));
    validate::collect(checks)?;

    let patch = LineItemPatch {
        name: name.transpose()?,
        ordinal: body.ordinal,
        format: body.format.map(Format::from),
        formula: body.formula.map(|formula| formula.and_then(formula_of)),
        summary: body.summary.map(SummaryMethod::from),
        time_summary: body
            .time_summary
            .map(|method| method.map(SummaryMethod::from)),
        applies_to: body.applies_to.map(|axes| axes.map(axes_of)),
        time_scale: body.time_scale.map(TimeScale::from),
        versions: body.versions.map(VersionsScope::from),
        notes: body.notes,
        code: body.code.map(|code| code.and_then(code_of)),
        read_access_driver: body.read_access_driver.map(|driver| driver.map(LineItemId)),
        write_access_driver: body
            .write_access_driver
            .map(|driver| driver.map(LineItemId)),
    };
    let snapshot = handle.snapshot();
    let mut references = References::new(snapshot.structure());
    if let Some(format) = &patch.format {
        references.format(format);
    }
    if let Some(method) = &patch.summary {
        references.summary("summary", method);
    }
    if let Some(Some(method)) = &patch.time_summary {
        references.summary("time_summary", method);
    }
    if let Some(Some(axes)) = &patch.applies_to {
        references.axes("applies_to", axes);
    }
    if let Some(versions) = &patch.versions {
        references.versions(versions);
    }
    if let Some(driver) = patch.read_access_driver {
        references.line_item("read_access_driver", driver);
    }
    if let Some(driver) = patch.write_access_driver {
        references.line_item("write_access_driver", driver);
    }
    references.finish()?;

    handle
        .apply(user.id, vec![Command::UpdateLineItem { id, patch }])
        .await?;
    let model = handle.snapshot();
    let updated = model.structure().line_item(id).ok_or(AppError::NotFound)?;
    Ok(Json(LineItemDto::from(updated)))
}

#[utoipa::path(
    delete,
    path = "/api/v1/models/{id}/line-items/{line_item_id}",
    tag = "modules",
    params(
        ("id" = Uuid, Path, description = "The model's id"),
        ("line_item_id" = Uuid, Path, description = "The line item's id"),
    ),
    responses(
        (status = 204, description = "The line item was deleted"),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model or line item, or the caller is not a member of the workspace (not_found)"),
        (status = 409, description = "The model is in production mode (model.production_locked), or another line item uses it as a ratio part or an access driver (structure.in_use)"),
    )
)]
pub(crate) async fn delete_line_item(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath((model_id, line_item_id)): ApiPath<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let handle = write_handle(&state, &user, model_id).await?;
    handle
        .apply(
            user.id,
            vec![Command::DeleteLineItem {
                id: LineItemId(line_item_id),
            }],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/v1/models/{id}/line-items/reorder",
    tag = "modules",
    params(("id" = Uuid, Path, description = "The model's id")),
    request_body = ReorderLineItemsRequest,
    responses(
        (status = 204, description = "The line items now have the order given"),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
        (status = 409, description = "The model is in production mode (model.production_locked)"),
        (status = 422, description = "The module or a line item does not exist, or the ids are not every line item of the module once (structure.invalid, validation)"),
    )
)]
pub(crate) async fn reorder_line_items(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(model_id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<ReorderLineItemsRequest>,
) -> AppResult<StatusCode> {
    let handle = write_handle(&state, &user, model_id).await?;
    let commands = reorder_commands(&handle.snapshot(), &body)?;
    handle.apply(user.id, commands).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/v1/models/{id}/formula/check",
    tag = "modules",
    params(("id" = Uuid, Path, description = "The model's id")),
    request_body = CheckFormulaRequest,
    responses(
        (status = 200, description = "Whether the formula would be accepted for the line item, with its type or every problem found. Nothing is changed.", body = CheckFormulaResponse),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 403, description = "Not a workspace builder (auth.forbidden)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
        (status = 422, description = "The line item does not exist (structure.invalid)"),
    )
)]
pub(crate) async fn check_formula(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(model_id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<CheckFormulaRequest>,
) -> AppResult<Json<CheckFormulaResponse>> {
    let handle = build_handle(&state, &user, model_id).await?;
    let model = handle.snapshot();
    let id = LineItemId(body.line_item_id);
    if model.structure().line_item(id).is_none() {
        return Err(AppError::MissingReferences(vec![FieldError {
            field: "line_item_id".to_string(),
            message: "The line item does not exist.".to_string(),
        }]));
    }
    // The check tries the formula on a copy of the model, which can take a while.
    let checked = tokio::task::spawn_blocking(move || model.check_formula(id, &body.formula))
        .await
        .map_err(|error| AppError::Internal(error.into()))?;
    Ok(Json(match checked {
        Ok(ty) => CheckFormulaResponse {
            ok: true,
            value_type: Some(ty.into()),
            errors: None,
        },
        Err(problems) => CheckFormulaResponse {
            ok: false,
            value_type: None,
            errors: Some(problems.iter().map(FormulaProblem::from).collect()),
        },
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/models/{id}/formula/completions",
    tag = "modules",
    params(("id" = Uuid, Path, description = "The model's id"), CompletionsQuery),
    responses(
        (status = 200, description = "What can be typed after the prefix, at most 50: the line items of the line item's module first, then those of other modules, lists, functions and keywords", body = [CompletionDto]),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
        (status = 422, description = "The line item is missing or does not exist (validation, structure.invalid)"),
    )
)]
pub(crate) async fn completions(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(model_id): ApiPath<Uuid>,
    ApiQuery(query): ApiQuery<CompletionsQuery>,
) -> AppResult<Json<Vec<CompletionDto>>> {
    let handle = read_handle(&state, &user, model_id).await?;
    let model = handle.snapshot();
    let id = LineItemId(query.line_item_id);
    if model.structure().line_item(id).is_none() {
        return Err(AppError::MissingReferences(vec![FieldError {
            field: "line_item_id".to_string(),
            message: "The line item does not exist.".to_string(),
        }]));
    }
    Ok(Json(
        model
            .completions(id, &query.prefix)
            .into_iter()
            .take(MAX_COMPLETIONS)
            .map(CompletionDto::from)
            .collect(),
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/formula/functions",
    tag = "modules",
    responses(
        (status = 200, description = "The built-in functions of the formula language, by category", body = [FunctionDto]),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
    )
)]
pub(crate) async fn functions_reference(_user: CurrentUser) -> Json<Vec<FunctionDto>> {
    Json(
        functions::all()
            .iter()
            .map(|def| FunctionDto {
                name: def.name.to_string(),
                category: def.category.to_string(),
                min_args: def.min_args,
                max_args: Some(def.max_args).filter(|max| *max != usize::MAX),
                doc: def.doc.to_string(),
                example: def.example.to_string(),
            })
            .collect(),
    )
}
