//! Pivoted views of a module: the rows, columns and pages of a grid, with the members of each
//! dimension, summaries, flags, filters and windowing.
//!
//! A view puts every dimension of a module (its axes and its line items) on the rows, on the
//! columns or on a page. Rows and columns are the cartesian product of the members of their
//! dimensions, and a window of them is returned with the cells in it. Cells are read with
//! [`Model::read`], one call for each line item, so summaries and the actual version before a
//! switchover are the ones formulas see.

mod cells;
mod filter;
mod members;

use crate::calendar::{Calendar, TimeLevel};
use crate::error::{EngineError, FormulaError};
use crate::ids::{LineItemId, ListId, ModuleId, SubsetId, TimeRangeId};
use crate::model::Model;
use crate::structure::{AxisSpec, LineItem, List, Module, Structure, Subset};
use crate::value::{Format, Value};
use members::{Frame, Node};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ops::Range;
use std::sync::Arc;

/// The most rows a window holds.
const MAX_ROW_LIMIT: usize = 1000;
/// The most columns a window holds.
const MAX_COL_LIMIT: usize = 200;
/// The most rows a view with filters may have before they are applied.
const MAX_FILTERED_ROWS: usize = 2_000_000;

/// A dimension of a module's grid: one of its axes, or its line items.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewDim {
    LineItems,
    List { list: ListId },
    Subset { subset: SubsetId },
    Time,
    Versions,
}

/// The member a page dimension shows; no key means its default member.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageSelection {
    pub dim: ViewDim,
    pub key: Option<String>,
}

/// One member of a dimension, named by its key. A list item (leaf or ancestor) and a version
/// or line item are keyed by their id, the total of a list by `"top"` and a time period by its
/// label.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberRef {
    pub dim: ViewDim,
    pub key: String,
}

/// The slice of a view to return.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub row_offset: usize,
    pub row_limit: usize,
    pub col_offset: usize,
    pub col_limit: usize,
}

/// How a filter compares the value of a row with its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    /// Whether the text, or the name of the list item, has the text in it, whatever the case.
    /// Only a line item of text or of a list takes it.
    Contains,
    IsBlank,
    NotBlank,
    IsTrue,
    IsFalse,
}

/// A condition on the rows of a view: the value of a line item for the row, compared with
/// `value`, which the blank, true and false operations leave out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RowFilter {
    pub line_item: LineItemId,
    pub op: FilterOp,
    #[serde(default)]
    pub value: Option<Value>,
}

fn yes() -> bool {
    true
}

/// What to show of a module.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewQuery {
    pub module: ModuleId,
    /// The line items to show and their order; all of them, by ordinal, when absent.
    #[serde(default)]
    pub line_items: Option<Vec<LineItemId>>,
    pub rows: Vec<ViewDim>,
    pub columns: Vec<ViewDim>,
    /// The member of every dimension that is on neither rows nor columns.
    #[serde(default)]
    pub pages: Vec<PageSelection>,
    /// Whether the summaries of lists and time are shown among their members. Without them
    /// `collapsed` is ignored, as there is nothing to collapse, and `hidden` still applies.
    #[serde(default = "yes")]
    pub show_summaries: bool,
    /// Summaries whose members are hidden. Ignored without summaries.
    #[serde(default)]
    pub collapsed: Vec<MemberRef>,
    /// Members left out, with or without summaries. The members below a hidden summary stay.
    #[serde(default)]
    pub hidden: Vec<MemberRef>,
    /// Conditions every row must meet. A view of more than 2,000,000 rows, before the filters
    /// are applied, is refused.
    #[serde(default)]
    pub filters: Vec<RowFilter>,
    pub window: Window,
}

/// A member of a dimension as a header shows it.
///
/// `depth` of a list member is its distance below the top of the list (the total, or the first
/// level of a list without one), so a parent is shallower than the items it adds up. It is 0
/// for the members of a list shown without summaries, and for subset members, versions and line
/// items. `depth` of a time period is its height above the periods of the module's level, so a
/// summary is deeper than the periods it adds up, the other way round from a list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Member {
    pub key: String,
    pub label: String,
    pub depth: u8,
    pub is_summary: bool,
    pub has_children: bool,
    pub collapsed: bool,
}

/// The members of one row or column, one for each dimension in dimension order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Header {
    pub members: Vec<Member>,
}

/// The member a page dimension shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PageMember {
    pub dim: ViewDim,
    pub member: Member,
}

/// What a cell is. A cell holds its flags in the order of this enum.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CellFlag {
    /// A cell of an input line item that can be typed into.
    Input,
    /// A cell of a line item with a formula.
    Calculated,
    /// A total of cells.
    Summary,
    Readonly,
    /// The line item has no cell here.
    Na,
    /// The formula of the line item has errors.
    Error,
    /// A cell of a version before its switchover, which shows the actual version's value.
    Switchover,
}

/// One cell of a view. `text` is the name that goes with an item value and the label that goes
/// with a period value.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Cell {
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub flags: Vec<CellFlag>,
}

/// What a client needs to know of a line item to show and edit its cells.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LineItemInfo {
    pub id: LineItemId,
    pub name: String,
    pub format: Format,
    pub is_input: bool,
    /// The line item's own axes, in axis order.
    pub dims: Vec<ViewDim>,
    pub errors: Vec<FormulaError>,
}

/// A window of a view.
///
/// `cells` holds a row of cells for each of `rows`, each as long as `columns`. A view with a page
/// that has no members, such as a list without items, has no rows or columns.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ViewResult {
    pub row_dims: Vec<ViewDim>,
    pub column_dims: Vec<ViewDim>,
    pub pages: Vec<PageMember>,
    pub rows: Vec<Header>,
    pub columns: Vec<Header>,
    pub total_rows: usize,
    pub total_columns: usize,
    pub cells: Vec<Vec<Cell>>,
    pub line_items: Vec<LineItemInfo>,
}

/// The rows of a view that pass its filters, as positions among all of its rows in the order the
/// view shows them. Finding them reads every row, so a caller that shows the same view again
/// with another window keeps them and hands them to [`query_with`].
pub type PassingRows = Arc<Vec<usize>>;

/// Runs a query against a model.
pub fn query(model: &Model, q: &ViewQuery) -> Result<ViewResult, EngineError> {
    query_with(model, q, None).map(|(result, _)| result)
}

/// Runs a query as [`query`] does, and gives the rows that pass its filters, none for a query
/// without filters.
///
/// `passing` is what an earlier call gave for the same model and the same query but for its
/// window, which saves reading the rows again. A set that cannot be of this view, because it
/// has a row the view does not, is worked out again; one of another query or model that happens
/// to fit gives the wrong rows.
pub fn query_with(
    model: &Model,
    q: &ViewQuery,
    passing: Option<&PassingRows>,
) -> Result<(ViewResult, Option<PassingRows>), EngineError> {
    check_window(&q.window)?;
    let cx = Cx::new(model, q.module, q.line_items.as_deref())?;
    let places = cx.place(q)?;
    let collapsed = cx.member_sets(&q.collapsed)?;
    let hidden = cx.member_sets(&q.hidden)?;
    let filters = cx.filter_plans(&q.filters)?;
    let pages = q
        .pages
        .iter()
        .map(|selection| cx.page(selection))
        .collect::<Result<Vec<_>, _>>()?;
    let line_items = cx.line_item_infos()?;
    let has_members = pages.iter().all(Option::is_some);
    let pages: Vec<(PageMember, Node)> = pages.into_iter().flatten().collect();
    let mut result = ViewResult {
        row_dims: q.rows.clone(),
        column_dims: q.columns.clone(),
        pages: pages.iter().map(|(member, _)| member.clone()).collect(),
        rows: Vec::new(),
        columns: Vec::new(),
        total_rows: 0,
        total_columns: 0,
        cells: Vec::new(),
        line_items,
    };
    if !has_members {
        return Ok((result, None));
    }
    let page_nodes: Vec<Node> = pages.iter().map(|(_, node)| *node).collect();

    let mut rows = cx.side(&q.rows, q.show_summaries, &collapsed, &hidden)?;
    let columns = cx.side(&q.columns, q.show_summaries, &collapsed, &hidden)?;
    rows.passing = cx.filter_rows(
        &Frame {
            places: &places,
            rows: &rows,
            columns: &columns,
            pages: &page_nodes,
        },
        &filters,
        passing,
    )?;
    result.total_rows = rows.count();
    result.total_columns = columns.count();
    let row_window = window_range(q.window.row_offset, q.window.row_limit, rows.count());
    let column_window = window_range(q.window.col_offset, q.window.col_limit, columns.count());
    let row_tuples: Vec<Vec<usize>> = row_window.map(|at| rows.tuple(at)).collect();
    let column_tuples: Vec<Vec<usize>> = column_window.map(|at| columns.tuple(at)).collect();
    result.rows = row_tuples.iter().map(|tuple| rows.header(tuple)).collect();
    result.columns = column_tuples
        .iter()
        .map(|tuple| columns.header(tuple))
        .collect();
    let frame = Frame {
        places: &places,
        rows: &rows,
        columns: &columns,
        pages: &page_nodes,
    };
    result.cells = cx.cells(&frame, &row_tuples, &column_tuples)?;
    Ok((result, rows.passing.clone()))
}

/// The members of one dimension of a module, in the order a view shows them.
pub fn members(
    model: &Model,
    module: ModuleId,
    dim: &ViewDim,
    show_summaries: bool,
) -> Result<Vec<Member>, EngineError> {
    let cx = Cx::new(model, module, None)?;
    cx.require_dim(dim)?;
    let namer = cx.namer(dim)?;
    Ok(cx
        .nodes(dim, show_summaries)?
        .iter()
        .map(|node| namer.member(node, false))
        .collect())
}

fn check_window(window: &Window) -> Result<(), EngineError> {
    if window.row_limit > MAX_ROW_LIMIT {
        return Err(EngineError::invalid(format!(
            "row_limit can't be more than {MAX_ROW_LIMIT}."
        )));
    }
    if window.col_limit > MAX_COL_LIMIT {
        return Err(EngineError::invalid(format!(
            "col_limit can't be more than {MAX_COL_LIMIT}."
        )));
    }
    Ok(())
}

/// The positions of a window among `count` rows or columns.
fn window_range(offset: usize, limit: usize, count: usize) -> Range<usize> {
    offset.min(count)..offset.saturating_add(limit).min(count)
}

/// Where a dimension of the module is in a view.
#[derive(Clone, Copy, Debug)]
enum Place {
    /// Position among the row dimensions.
    Row(usize),
    Column(usize),
    Page(usize),
}

#[derive(Clone, Copy)]
struct TimeAxis {
    level: TimeLevel,
    range: Option<TimeRangeId>,
    calendar: Calendar,
}

/// A module being viewed.
struct Cx<'a> {
    model: &'a Model,
    structure: &'a Structure,
    /// The module's axes, then its line items.
    dims: Vec<ViewDim>,
    /// The members of the line items dimension.
    line_items: Vec<LineItemId>,
    time: Option<TimeAxis>,
    /// The label of every period of the module's calendar, by level (indexed as the `TimeLevel`
    /// enum is declared, finest first) and period; empty without a time dimension.
    period_labels: Vec<Vec<String>>,
}

impl<'a> Cx<'a> {
    fn new(
        model: &'a Model,
        module: ModuleId,
        order: Option<&[LineItemId]>,
    ) -> Result<Cx<'a>, EngineError> {
        let structure = model.structure();
        let module = structure
            .module(module)
            .ok_or_else(|| EngineError::not_found("module", module.0))?;
        let mut dims: Vec<ViewDim> = module
            .axes
            .iter()
            .map(|axis| match axis {
                AxisSpec::List { list } => ViewDim::List { list: *list },
                AxisSpec::Subset { subset } => ViewDim::Subset { subset: *subset },
                AxisSpec::Time { .. } => ViewDim::Time,
                AxisSpec::Versions => ViewDim::Versions,
            })
            .collect();
        dims.push(ViewDim::LineItems);
        let time = module
            .axes
            .iter()
            .find_map(|axis| match axis {
                AxisSpec::Time { level, range } => Some((*level, *range)),
                _ => None,
            })
            .map(|(level, range)| {
                structure.time_calendar(range).map(|calendar| TimeAxis {
                    level,
                    range,
                    calendar,
                })
            })
            .transpose()?;
        let line_items = match order {
            Some(ids) => {
                check_line_items(structure, module, ids)?;
                ids.to_vec()
            }
            None => {
                let mut all: Vec<&LineItem> = structure.line_items_in(module.id).collect();
                all.sort_by_key(|line_item| line_item.ordinal);
                all.iter().map(|line_item| line_item.id).collect()
            }
        };
        let period_labels = time.map_or_else(Vec::new, |time| {
            [
                TimeLevel::Month,
                TimeLevel::Quarter,
                TimeLevel::HalfYear,
                TimeLevel::Year,
                TimeLevel::All,
            ]
            .map(|level| {
                (0..time.calendar.periods(level))
                    .map(|period| time.calendar.label(level, period))
                    .collect()
            })
            .into()
        });
        Ok(Cx {
            model,
            structure,
            dims,
            line_items,
            time,
            period_labels,
        })
    }

    fn dim_index(&self, dim: &ViewDim) -> Option<usize> {
        self.dims.iter().position(|candidate| candidate == dim)
    }

    /// The position of a dimension of the module, or the problem with it.
    fn require_dim(&self, dim: &ViewDim) -> Result<usize, EngineError> {
        self.dim_index(dim).ok_or_else(|| {
            EngineError::invalid(format!(
                "The module doesn't have the dimension '{}'.",
                self.dim_name(dim)
            ))
        })
    }

    fn dim_name(&self, dim: &ViewDim) -> String {
        match dim {
            ViewDim::LineItems => "Line items".to_string(),
            ViewDim::List { list } => self
                .structure
                .list(*list)
                .map_or_else(|| list.0.to_string(), |list| list.name.clone()),
            ViewDim::Subset { subset } => self
                .structure
                .subset(*subset)
                .map_or_else(|| subset.0.to_string(), |subset| subset.name.clone()),
            ViewDim::Time => "Time".to_string(),
            ViewDim::Versions => "Versions".to_string(),
        }
    }

    fn list(&self, id: ListId) -> Result<&'a List, EngineError> {
        self.structure
            .list(id)
            .ok_or_else(|| EngineError::not_found("list", id.0))
    }

    fn subset(&self, id: SubsetId) -> Result<&'a Subset, EngineError> {
        self.structure
            .subset(id)
            .ok_or_else(|| EngineError::not_found("subset", id.0))
    }

    /// Where every dimension of the module is, if each is on the rows, columns or pages once.
    fn place(&self, q: &ViewQuery) -> Result<Vec<Place>, EngineError> {
        let mut places: Vec<Option<Place>> = vec![None; self.dims.len()];
        let placements = q
            .rows
            .iter()
            .enumerate()
            .map(|(at, dim)| (dim, Place::Row(at)))
            .chain(
                q.columns
                    .iter()
                    .enumerate()
                    .map(|(at, dim)| (dim, Place::Column(at))),
            )
            .chain(
                q.pages
                    .iter()
                    .enumerate()
                    .map(|(at, page)| (&page.dim, Place::Page(at))),
            );
        for (dim, place) in placements {
            let at = self.require_dim(dim)?;
            if places[at].replace(place).is_some() {
                return Err(EngineError::invalid(format!(
                    "The dimension '{}' appears more than once in the view.",
                    self.dim_name(dim)
                )));
            }
        }
        if let Some(missing) = self
            .dims
            .iter()
            .zip(&places)
            .find_map(|(dim, place)| place.is_none().then_some(dim))
        {
            return Err(EngineError::invalid(format!(
                "The view is missing the dimension '{}': put it in the rows, columns or pages.",
                self.dim_name(missing)
            )));
        }
        Ok(places.into_iter().flatten().collect())
    }
}

/// Checks the line items a query lists: each is one of the module's, and none is listed twice.
fn check_line_items(
    structure: &Structure,
    module: &Module,
    ids: &[LineItemId],
) -> Result<(), EngineError> {
    let mut seen = HashSet::new();
    for id in ids {
        if !structure
            .line_item(*id)
            .is_some_and(|line_item| line_item.module == module.id)
        {
            return Err(EngineError::invalid(format!(
                "The view lists a line item that isn't in module '{}'.",
                module.name
            )));
        }
        if !seen.insert(*id) {
            return Err(EngineError::invalid(
                "The view lists a line item more than once.",
            ));
        }
    }
    Ok(())
}
