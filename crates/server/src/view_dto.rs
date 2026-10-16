//! The JSON of the view endpoints: what a client asks of a module's grid, and the window of it
//! that the server answers with. They mirror the engine's view types field by field, and a test
//! holds an answer to what the engine itself writes.

use openplan_engine::{
    CellFlag, FilterOp, Header, LineItemId, LineItemInfo, ListId, Member, MemberRef, ModuleId,
    PageMember, PageSelection, RowFilter, SubsetId, ViewDim, ViewQuery, ViewResult, Window,
    view::Cell,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    cells_api::ValueDto,
    error::{AppError, AppResult, FieldError, FormulaProblem},
    extract::Capped,
    structure_dto::FormatDto,
};

/// The most filters a query has.
pub const MAX_FILTERS: usize = 10;
/// The most line items a query lists.
pub const MAX_LINE_ITEMS: usize = 1_000;
/// The most members a query lists as collapsed, and as hidden.
pub const MAX_MEMBERS: usize = 5_000;

/// A dimension of a module's grid: one of its axes, or its line items.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewDimDto {
    LineItems,
    List {
        list: Uuid,
    },
    Subset {
        subset: Uuid,
    },
    /// The Time axis of the module.
    Time,
    Versions,
}

impl From<ViewDimDto> for ViewDim {
    fn from(dim: ViewDimDto) -> Self {
        match dim {
            ViewDimDto::LineItems => ViewDim::LineItems,
            ViewDimDto::List { list } => ViewDim::List { list: ListId(list) },
            ViewDimDto::Subset { subset } => ViewDim::Subset {
                subset: SubsetId(subset),
            },
            ViewDimDto::Time => ViewDim::Time,
            ViewDimDto::Versions => ViewDim::Versions,
        }
    }
}

impl From<ViewDim> for ViewDimDto {
    fn from(dim: ViewDim) -> Self {
        match dim {
            ViewDim::LineItems => ViewDimDto::LineItems,
            ViewDim::List { list } => ViewDimDto::List { list: list.0 },
            ViewDim::Subset { subset } => ViewDimDto::Subset { subset: subset.0 },
            ViewDim::Time => ViewDimDto::Time,
            ViewDim::Versions => ViewDimDto::Versions,
        }
    }
}

/// The member that a dimension on a page shows.
#[derive(Deserialize, ToSchema)]
pub struct PageSelectionDto {
    dim: ViewDimDto,
    /// The key of the member; the default member of the dimension when it is absent.
    key: Option<String>,
}

/// One member of a dimension, named by its key. A list item (at any level), a version and a line
/// item are keyed by their id, the total of a list by `"top"` and a period by its label.
#[derive(Deserialize, ToSchema)]
pub struct MemberRefDto {
    dim: ViewDimDto,
    key: String,
}

/// The slice of a view to return.
#[derive(Deserialize, ToSchema)]
pub struct WindowDto {
    row_offset: usize,
    /// At most 1,000.
    row_limit: usize,
    col_offset: usize,
    /// At most 200.
    col_limit: usize,
}

/// How a filter compares the value of a row with its own.
#[derive(Clone, Copy, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FilterOpDto {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    /// Whether a text, or the name of a list item, has the text in it, whatever the case. Only a
    /// line item of text or of a list takes it.
    Contains,
    IsBlank,
    NotBlank,
    IsTrue,
    IsFalse,
}

impl From<FilterOpDto> for FilterOp {
    fn from(op: FilterOpDto) -> Self {
        match op {
            FilterOpDto::Eq => FilterOp::Eq,
            FilterOpDto::Ne => FilterOp::Ne,
            FilterOpDto::Lt => FilterOp::Lt,
            FilterOpDto::Le => FilterOp::Le,
            FilterOpDto::Gt => FilterOp::Gt,
            FilterOpDto::Ge => FilterOp::Ge,
            FilterOpDto::Contains => FilterOp::Contains,
            FilterOpDto::IsBlank => FilterOp::IsBlank,
            FilterOpDto::NotBlank => FilterOp::NotBlank,
            FilterOpDto::IsTrue => FilterOp::IsTrue,
            FilterOpDto::IsFalse => FilterOp::IsFalse,
        }
    }
}

/// A condition on the rows of a view: the value of a line item for the row, compared with
/// `value`, which the blank, true and false operations leave out.
#[derive(Deserialize, ToSchema)]
pub struct RowFilterDto {
    line_item: Uuid,
    op: FilterOpDto,
    #[serde(default)]
    value: Option<ValueDto>,
}

fn yes() -> bool {
    true
}

/// What to show of a module: its dimensions on rows, columns and pages, and the window of the
/// rows and columns to return.
#[derive(Deserialize, ToSchema)]
pub struct ViewQueryDto {
    module: Uuid,
    /// The line items to show and their order; all of them, by ordinal, when absent. At most
    /// 1,000.
    #[serde(default)]
    #[schema(value_type = Option<Vec<Uuid>>)]
    line_items: Option<Capped<Uuid, MAX_LINE_ITEMS>>,
    /// Every dimension of the module, its axes and its line items, is on the rows, the columns or
    /// the pages, once.
    rows: Vec<ViewDimDto>,
    columns: Vec<ViewDimDto>,
    /// The member shown of each dimension that is on neither rows nor columns.
    #[serde(default)]
    pages: Vec<PageSelectionDto>,
    /// Whether the totals of lists and time are shown among their members. Without them
    /// `collapsed` is ignored, and `hidden` still applies.
    #[serde(default = "yes")]
    show_summaries: bool,
    /// Totals whose members are left out. At most 5,000.
    #[serde(default)]
    #[schema(value_type = Vec<MemberRefDto>)]
    collapsed: Capped<MemberRefDto, MAX_MEMBERS>,
    /// Members left out. The members below a hidden total stay. At most 5,000.
    #[serde(default)]
    #[schema(value_type = Vec<MemberRefDto>)]
    hidden: Capped<MemberRefDto, MAX_MEMBERS>,
    /// Conditions every row has to meet. A view of more than 2,000,000 rows, before the filters
    /// are applied, is refused. At most 10.
    #[serde(default)]
    #[schema(value_type = Vec<RowFilterDto>)]
    filters: Capped<RowFilterDto, MAX_FILTERS>,
    window: WindowDto,
}

fn too_many(field: &str, message: &str) -> AppError {
    AppError::Validation(vec![FieldError {
        field: field.to_string(),
        message: message.to_string(),
    }])
}

impl ViewQueryDto {
    /// The query for the engine, or the first of the lists that is longer than a query may have.
    pub fn into_query(self) -> AppResult<ViewQuery> {
        if self.filters.is_over() {
            return Err(too_many("filters", "Send at most 10 filters."));
        }
        if self.line_items.as_ref().is_some_and(Capped::is_over) {
            return Err(too_many("line_items", "Send at most 1,000 line items."));
        }
        if self.collapsed.is_over() {
            return Err(too_many(
                "collapsed",
                "Send at most 5,000 collapsed members.",
            ));
        }
        if self.hidden.is_over() {
            return Err(too_many("hidden", "Send at most 5,000 hidden members."));
        }
        let members = |refs: Capped<MemberRefDto, MAX_MEMBERS>| -> Vec<MemberRef> {
            refs.into_vec()
                .into_iter()
                .map(|member| MemberRef {
                    dim: member.dim.into(),
                    key: member.key,
                })
                .collect()
        };
        Ok(ViewQuery {
            module: ModuleId(self.module),
            line_items: self.line_items.map(|ids| {
                ids.into_vec()
                    .into_iter()
                    .map(LineItemId)
                    .collect::<Vec<_>>()
            }),
            rows: self.rows.into_iter().map(ViewDim::from).collect(),
            columns: self.columns.into_iter().map(ViewDim::from).collect(),
            pages: self
                .pages
                .into_iter()
                .map(|page| PageSelection {
                    dim: page.dim.into(),
                    key: page.key,
                })
                .collect(),
            show_summaries: self.show_summaries,
            collapsed: members(self.collapsed),
            hidden: members(self.hidden),
            filters: self
                .filters
                .into_vec()
                .into_iter()
                .map(|filter| RowFilter {
                    line_item: LineItemId(filter.line_item),
                    op: filter.op.into(),
                    value: filter.value.map(Into::into),
                })
                .collect(),
            window: Window {
                row_offset: self.window.row_offset,
                row_limit: self.window.row_limit,
                col_offset: self.window.col_offset,
                col_limit: self.window.col_limit,
            },
        })
    }
}

/// The dimension whose members to list, in a module.
#[derive(Deserialize, ToSchema)]
pub struct MembersRequest {
    pub module_id: Uuid,
    pub dim: ViewDimDto,
    /// Whether the totals are listed among the members, as in a query. True when absent.
    #[serde(default = "yes")]
    pub show_summaries: bool,
}

/// One member of a dimension as a header shows it.
#[derive(Serialize, ToSchema)]
pub struct ViewMemberDto {
    /// What a query names the member by.
    key: String,
    label: String,
    /// How far below the top of a list the member is, or how far above the periods of the
    /// module's level a period is.
    depth: u8,
    is_summary: bool,
    has_children: bool,
    /// Whether the members below it are left out of the query.
    collapsed: bool,
}

impl From<Member> for ViewMemberDto {
    fn from(member: Member) -> Self {
        ViewMemberDto {
            key: member.key,
            label: member.label,
            depth: member.depth,
            is_summary: member.is_summary,
            has_children: member.has_children,
            collapsed: member.collapsed,
        }
    }
}

#[derive(Serialize, ToSchema)]
pub struct MembersResponse {
    pub members: Vec<ViewMemberDto>,
}

/// The members of one row or column, one for each of its dimensions, in dimension order.
#[derive(Serialize, ToSchema)]
pub struct HeaderDto {
    members: Vec<ViewMemberDto>,
}

/// The member a dimension on a page shows.
#[derive(Serialize, ToSchema)]
pub struct PageMemberDto {
    dim: ViewDimDto,
    member: ViewMemberDto,
}

/// What a cell is.
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CellFlagDto {
    /// A cell of an input line item that can be typed into.
    Input,
    /// A cell of a line item with a formula.
    Calculated,
    /// A total of cells.
    Summary,
    /// A cell that cannot be typed into, whatever its other flags say.
    Readonly,
    /// The line item has no cell here.
    Na,
    /// The formula of the line item has errors.
    Error,
    /// A cell of a version before its switchover, which shows the actual version's value.
    Switchover,
}

impl From<CellFlag> for CellFlagDto {
    fn from(flag: CellFlag) -> Self {
        match flag {
            CellFlag::Input => CellFlagDto::Input,
            CellFlag::Calculated => CellFlagDto::Calculated,
            CellFlag::Summary => CellFlagDto::Summary,
            CellFlag::Readonly => CellFlagDto::Readonly,
            CellFlag::Na => CellFlagDto::Na,
            CellFlag::Error => CellFlagDto::Error,
            CellFlag::Switchover => CellFlagDto::Switchover,
        }
    }
}

/// One cell of a view.
#[derive(Serialize, ToSchema)]
pub struct CellDto {
    value: ValueDto,
    /// The name that goes with an item value and the label that goes with a period value.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(nullable = false)]
    text: Option<String>,
    /// In the order they are listed in here.
    flags: Vec<CellFlagDto>,
}

impl CellDto {
    fn new(cell: Cell, readonly: bool) -> CellDto {
        let mut flags = cell.flags;
        if readonly && let Err(at) = flags.binary_search(&CellFlag::Readonly) {
            flags.insert(at, CellFlag::Readonly);
        }
        CellDto {
            value: ValueDto::from(&cell.value),
            text: cell.text,
            flags: flags.into_iter().map(CellFlagDto::from).collect(),
        }
    }
}

/// What a client needs to know of a line item to show and edit its cells.
#[derive(Serialize, ToSchema)]
pub struct LineItemInfoDto {
    id: Uuid,
    name: String,
    format: FormatDto,
    is_input: bool,
    /// The line item's own dimensions, in the order of its axes.
    dims: Vec<ViewDimDto>,
    /// What is wrong with its formula.
    errors: Vec<FormulaProblem>,
}

impl From<LineItemInfo> for LineItemInfoDto {
    fn from(info: LineItemInfo) -> Self {
        LineItemInfoDto {
            id: info.id.0,
            name: info.name,
            format: FormatDto::from(&info.format),
            is_input: info.is_input,
            dims: info.dims.into_iter().map(ViewDimDto::from).collect(),
            errors: info.errors.iter().map(FormulaProblem::from).collect(),
        }
    }
}

/// A window of a view.
///
/// `cells` holds a row of cells for each of `rows`, each as long as `columns`. A view with a
/// page that has no members, such as a list without items, has no rows or columns.
#[derive(Serialize, ToSchema)]
pub struct ViewResultDto {
    row_dims: Vec<ViewDimDto>,
    column_dims: Vec<ViewDimDto>,
    pages: Vec<PageMemberDto>,
    rows: Vec<HeaderDto>,
    columns: Vec<HeaderDto>,
    /// How many rows the view has, with the window or without it.
    total_rows: usize,
    total_columns: usize,
    cells: Vec<Vec<CellDto>>,
    line_items: Vec<LineItemInfoDto>,
    /// The sequence number of the last change of the model that the window shows. A change that
    /// comes after it, told of on the live channel, is not in the window.
    seq: i64,
}

fn headers(headers: Vec<Header>) -> Vec<HeaderDto> {
    headers
        .into_iter()
        .map(|header| HeaderDto {
            members: header
                .members
                .into_iter()
                .map(ViewMemberDto::from)
                .collect(),
        })
        .collect()
}

impl ViewResultDto {
    /// The window as the server answers with it, for the state of the model at `seq`. A caller
    /// who may only read the model has `readonly` added to every cell.
    pub fn new(result: ViewResult, seq: i64, readonly: bool) -> ViewResultDto {
        ViewResultDto {
            row_dims: result.row_dims.into_iter().map(ViewDimDto::from).collect(),
            column_dims: result
                .column_dims
                .into_iter()
                .map(ViewDimDto::from)
                .collect(),
            pages: result
                .pages
                .into_iter()
                .map(|PageMember { dim, member }| PageMemberDto {
                    dim: dim.into(),
                    member: member.into(),
                })
                .collect(),
            rows: headers(result.rows),
            columns: headers(result.columns),
            total_rows: result.total_rows,
            total_columns: result.total_columns,
            cells: result
                .cells
                .into_iter()
                .map(|row| {
                    row.into_iter()
                        .map(|cell| CellDto::new(cell, readonly))
                        .collect()
                })
                .collect(),
            line_items: result
                .line_items
                .into_iter()
                .map(LineItemInfoDto::from)
                .collect(),
            seq,
        }
    }
}
