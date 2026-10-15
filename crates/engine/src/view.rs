//! Pivoted views of a module: the rows, columns and pages of a grid, with the members of each
//! dimension, summaries, flags, filters and windowing.
//!
//! A view puts every dimension of a module (its axes and its line items) on the rows, on the
//! columns or on a page. Rows and columns are the cartesian product of the members of their
//! dimensions, and a window of them is returned with the cells in it. Cells are read with
//! [`Model::read`], one call for each line item, so summaries and the actual version before a
//! switchover are the ones formulas see.

use std::cmp::Ordering;
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::ops::Range;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::calendar::{Calendar, TimeLevel};
use crate::command::CoordToken;
use crate::error::{EngineError, FormulaError};
use crate::ids::{ItemId, LineItemId, ListId, ModuleId, SubsetId, TimeRangeId, VersionId};
use crate::model::{Model, blank_value};
use crate::shape::Axis;
use crate::structure::{AxisSpec, LineItem, List, Module, Structure, Subset, fold};
use crate::summary::ancestors;
use crate::value::{Format, Value};

/// The most rows a window holds.
const MAX_ROW_LIMIT: usize = 1000;
/// The most columns a window holds.
const MAX_COL_LIMIT: usize = 200;

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
    #[serde(default = "yes")]
    pub show_summaries: bool,
    /// Summaries whose members are hidden.
    #[serde(default)]
    pub collapsed: Vec<MemberRef>,
    /// Members left out.
    #[serde(default)]
    pub hidden: Vec<MemberRef>,
    #[serde(default)]
    pub filters: Vec<RowFilter>,
    pub window: Window,
}

/// A member of a dimension as a header shows it.
///
/// `depth` counts the levels above a list or subset member, and the levels a time period lies
/// above the periods of its module.
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

/// Runs a query against a model.
pub fn query(model: &Model, q: &ViewQuery) -> Result<ViewResult, EngineError> {
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
        return Ok(result);
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
    Ok(result)
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
        return Err(invalid(format!(
            "row_limit can't be more than {MAX_ROW_LIMIT}."
        )));
    }
    if window.col_limit > MAX_COL_LIMIT {
        return Err(invalid(format!(
            "col_limit can't be more than {MAX_COL_LIMIT}."
        )));
    }
    Ok(())
}

/// The positions of a window among `count` rows or columns.
fn window_range(offset: usize, limit: usize, count: usize) -> Range<usize> {
    offset.min(count)..offset.saturating_add(limit).min(count)
}

fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::Invalid {
        message: message.into(),
    }
}

fn not_found(what: &'static str, id: Uuid) -> EngineError {
    EngineError::NotFound {
        what,
        id: id.to_string(),
    }
}

/// Which member of a dimension a node is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Id {
    /// The total of a list.
    Top,
    /// An item of a list or subset, at any level.
    Item(ItemId),
    Period(TimeLevel, u32),
    Version(VersionId),
    LineItem(LineItemId),
}

/// A member of a dimension in the tree a view shows.
#[derive(Clone, Copy, Debug)]
struct Node {
    id: Id,
    depth: u8,
    summary: bool,
    children: bool,
    /// The summary this member is part of.
    parent: Option<usize>,
}

impl Node {
    fn leaf(id: Id) -> Node {
        Node {
            id,
            depth: 0,
            summary: false,
            children: false,
            parent: None,
        }
    }

    fn total(id: Id) -> Node {
        Node {
            summary: true,
            ..Node::leaf(id)
        }
    }
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
            .ok_or_else(|| not_found("module", module.0))?;
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
        Ok(Cx {
            model,
            structure,
            dims,
            line_items,
            time,
        })
    }

    fn dim_index(&self, dim: &ViewDim) -> Option<usize> {
        self.dims.iter().position(|candidate| candidate == dim)
    }

    /// The position of a dimension of the module, or the problem with it.
    fn require_dim(&self, dim: &ViewDim) -> Result<usize, EngineError> {
        self.dim_index(dim).ok_or_else(|| {
            invalid(format!(
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
            .ok_or_else(|| not_found("list", id.0))
    }

    fn subset(&self, id: SubsetId) -> Result<&'a Subset, EngineError> {
        self.structure
            .subset(id)
            .ok_or_else(|| not_found("subset", id.0))
    }

    /// The dimension of the module that holds the items of a list, as a list or as a subset.
    fn list_dim(&self, list: ListId) -> Option<usize> {
        self.dims.iter().position(|dim| match dim {
            ViewDim::List { list: own } => *own == list,
            ViewDim::Subset { subset } => self
                .structure
                .subset(*subset)
                .is_some_and(|subset| subset.list == list),
            _ => false,
        })
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
                return Err(invalid(format!(
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
            return Err(invalid(format!(
                "The view is missing the dimension '{}': put it in the rows, columns or pages.",
                self.dim_name(missing)
            )));
        }
        Ok(places.into_iter().flatten().collect())
    }

    /// The members a dimension has, with the summaries above them when asked for.
    fn nodes(&self, dim: &ViewDim, summaries: bool) -> Result<Vec<Node>, EngineError> {
        Ok(match dim {
            ViewDim::LineItems => self
                .line_items
                .iter()
                .map(|id| Node::leaf(Id::LineItem(*id)))
                .collect(),
            ViewDim::List { list } => self.list_nodes(*list, summaries)?,
            ViewDim::Subset { subset } => self
                .subset(*subset)?
                .items
                .iter()
                .map(|item| Node::leaf(Id::Item(*item)))
                .collect(),
            ViewDim::Time => self.time_nodes(summaries),
            ViewDim::Versions => self
                .structure
                .versions()
                .iter()
                .map(|version| Node::leaf(Id::Version(version.id)))
                .collect(),
        })
    }

    /// The items of a list. With summaries they are a tree, a parent before the items below it,
    /// under the total of the list if it has one; without, the items in list order.
    fn list_nodes(&self, id: ListId, summaries: bool) -> Result<Vec<Node>, EngineError> {
        let list = self.list(id)?;
        if !summaries {
            return Ok(list
                .items()
                .map(|(_, item)| Node::leaf(Id::Item(item.id)))
                .collect());
        }
        // The lists from the top of the hierarchy down to this one, and for each the items below
        // every item of the list above.
        let mut levels = ancestors(self.structure, id)?
            .into_iter()
            .map(|level| self.list(level))
            .collect::<Result<Vec<_>, _>>()?;
        levels.reverse();
        let children: Vec<HashMap<ItemId, Vec<ItemId>>> = levels
            .iter()
            .map(|level| {
                let mut below: HashMap<ItemId, Vec<ItemId>> = HashMap::new();
                for (_, item) in level.items() {
                    if let Some(parent) = item.parent {
                        below.entry(parent).or_default().push(item.id);
                    }
                }
                below
            })
            .collect();

        let roots = levels[0].items().map(|(_, item)| item.id);
        let mut nodes = Vec::new();
        let (mut parent, mut depth) = (None, 0);
        if list.top_level_name.is_some() {
            nodes.push(Node {
                children: levels[0].items().next().is_some(),
                ..Node::total(Id::Top)
            });
            (parent, depth) = (Some(0), 1);
        }
        for root in roots {
            emit_item(&mut nodes, &children, 0, root, depth, parent);
        }
        Ok(nodes)
    }

    /// The periods of the module's Time dimension. With summaries the periods above them follow
    /// the periods they add up, the total last.
    fn time_nodes(&self, summaries: bool) -> Vec<Node> {
        let Some(time) = &self.time else {
            return Vec::new();
        };
        if !summaries || time.level == TimeLevel::All {
            return (0..time.calendar.periods(time.level))
                .map(|period| Node::leaf(Id::Period(time.level, period)))
                .collect();
        }
        let mut nodes = Vec::new();
        emit_period(&mut nodes, &time.calendar, time.level, TimeLevel::All, 0);
        nodes
    }

    /// The member of a dimension that a key names.
    fn resolve(&self, dim: &ViewDim, key: &str) -> Result<Id, EngineError> {
        self.require_dim(dim)?;
        let uuid = Uuid::parse_str(key).ok();
        let found = match dim {
            ViewDim::LineItems => uuid
                .map(LineItemId)
                .filter(|id| self.line_items.contains(id))
                .map(Id::LineItem),
            ViewDim::List { list } => {
                if key == "top" {
                    self.list(*list)?
                        .top_level_name
                        .is_some()
                        .then_some(Id::Top)
                } else {
                    let levels = ancestors(self.structure, *list)?;
                    uuid.map(ItemId)
                        .filter(|item| {
                            levels.iter().any(|level| {
                                self.structure
                                    .list(*level)
                                    .is_some_and(|level| level.idx(*item).is_some())
                            })
                        })
                        .map(Id::Item)
                }
            }
            ViewDim::Subset { subset } => {
                let subset = self.subset(*subset)?;
                uuid.map(ItemId)
                    .filter(|item| subset.items.contains(item))
                    .map(Id::Item)
            }
            ViewDim::Time => self.time.as_ref().and_then(|time| {
                time.calendar
                    .parse_label(key)
                    .filter(|(level, _)| *level >= time.level)
                    .map(|(level, period)| Id::Period(level, period))
            }),
            ViewDim::Versions => uuid
                .map(VersionId)
                .filter(|id| self.structure.version(*id).is_some())
                .map(Id::Version),
        };
        found.ok_or_else(|| {
            invalid(format!(
                "'{key}' is not a member of '{}'.",
                self.dim_name(dim)
            ))
        })
    }

    /// The members that references name in each dimension of the module.
    fn member_sets(&self, refs: &[MemberRef]) -> Result<Vec<HashSet<Id>>, EngineError> {
        let mut sets = vec![HashSet::new(); self.dims.len()];
        for member in refs {
            let id = self.resolve(&member.dim, &member.key)?;
            sets[self.require_dim(&member.dim)?].insert(id);
        }
        Ok(sets)
    }

    fn namer(&self, dim: &ViewDim) -> Result<Namer<'a>, EngineError> {
        let mut namer = Namer {
            structure: self.structure,
            lists: Vec::new(),
            top: None,
            calendar: self.time.map(|time| time.calendar),
        };
        match dim {
            ViewDim::List { list } => {
                namer.lists = ancestors(self.structure, *list)?
                    .into_iter()
                    .map(|level| self.list(level))
                    .collect::<Result<_, _>>()?;
                namer.top = self.list(*list)?.top_level_name.as_deref();
            }
            ViewDim::Subset { subset } => {
                namer.lists = vec![self.list(self.subset(*subset)?.list)?];
            }
            ViewDim::LineItems | ViewDim::Time | ViewDim::Versions => {}
        }
        Ok(namer)
    }

    /// The members of a dimension that a row or column shows.
    fn shown(
        &self,
        dim: &ViewDim,
        summaries: bool,
        collapsed: &HashSet<Id>,
        hidden: &HashSet<Id>,
    ) -> Result<Shown<'a>, EngineError> {
        let nodes = self.nodes(dim, summaries)?;
        let collapsed = if summaries {
            collapsed.clone()
        } else {
            HashSet::new()
        };
        let shown = (0..nodes.len())
            .filter(|&at| {
                !hidden.contains(&nodes[at].id) && !under_collapsed(&nodes, at, &collapsed)
            })
            .collect();
        Ok(Shown {
            dim: dim.clone(),
            nodes,
            shown,
            collapsed,
            namer: self.namer(dim)?,
        })
    }

    fn side(
        &self,
        dims: &[ViewDim],
        summaries: bool,
        collapsed: &[HashSet<Id>],
        hidden: &[HashSet<Id>],
    ) -> Result<Side<'a>, EngineError> {
        let dims = dims
            .iter()
            .map(|dim| {
                let at = self.require_dim(dim)?;
                self.shown(dim, summaries, &collapsed[at], &hidden[at])
            })
            .collect::<Result<_, _>>()?;
        Ok(Side {
            dims,
            passing: None,
        })
    }

    /// The member a page shows, with the node that stands for it, or `None` for a dimension
    /// without members.
    fn page(&self, selection: &PageSelection) -> Result<Option<(PageMember, Node)>, EngineError> {
        self.require_dim(&selection.dim)?;
        let id = match &selection.key {
            Some(key) => Some(self.resolve(&selection.dim, key)?),
            None => self.default_member(&selection.dim)?,
        };
        let Some(id) = id else {
            return Ok(None);
        };
        let namer = self.namer(&selection.dim)?;
        Ok(self
            .nodes(&selection.dim, true)?
            .into_iter()
            .find(|node| node.id == id)
            .map(|node| {
                let member = PageMember {
                    dim: selection.dim.clone(),
                    member: namer.member(&node, false),
                };
                (member, node)
            }))
    }

    /// The member a page starts at: the total of a list that has one, else its first item.
    fn default_member(&self, dim: &ViewDim) -> Result<Option<Id>, EngineError> {
        Ok(match dim {
            ViewDim::LineItems => self.line_items.first().copied().map(Id::LineItem),
            ViewDim::List { list } => {
                let list = self.list(*list)?;
                if list.top_level_name.is_some() {
                    Some(Id::Top)
                } else {
                    list.items().next().map(|(_, item)| Id::Item(item.id))
                }
            }
            ViewDim::Subset { subset } => {
                self.subset(*subset)?.items.first().copied().map(Id::Item)
            }
            ViewDim::Time => self.time.map(|time| Id::Period(time.level, 0)),
            ViewDim::Versions => self
                .structure
                .versions()
                .iter()
                .find(|version| version.is_current)
                .map(|version| Id::Version(version.id)),
        })
    }

    fn line_item_infos(&self) -> Result<Vec<LineItemInfo>, EngineError> {
        self.line_items
            .iter()
            .map(|id| {
                let line_item = self
                    .structure
                    .line_item(*id)
                    .ok_or_else(|| not_found("line item", id.0))?;
                let layout = self.structure.layout(line_item)?;
                Ok(LineItemInfo {
                    id: *id,
                    name: line_item.name.clone(),
                    format: line_item.format.clone(),
                    is_input: line_item.formula.is_none(),
                    dims: layout
                        .axes
                        .iter()
                        .filter_map(|axis| match axis {
                            Axis::List(list) => Some(ViewDim::List { list: *list }),
                            Axis::Subset(subset) => Some(ViewDim::Subset { subset: *subset }),
                            Axis::Time { .. } => Some(ViewDim::Time),
                            Axis::Versions => Some(ViewDim::Versions),
                            Axis::ListTop(_) => None,
                        })
                        .collect(),
                    errors: self
                        .model
                        .line_item_errors(*id)
                        .map(<[FormulaError]>::to_vec)
                        .unwrap_or_default(),
                })
            })
            .collect()
    }

    /// How a line item's cells line up with the dimensions of the view.
    fn plan(&self, id: LineItemId) -> Result<LiPlan<'a>, EngineError> {
        let structure = self.structure;
        let line_item = structure
            .line_item(id)
            .ok_or_else(|| not_found("line item", id.0))?;
        let layout = structure.layout(line_item)?;
        let mut axes = Vec::with_capacity(layout.axes.len());
        let mut in_view = true;
        for axis in &layout.axes {
            let planned = match axis {
                Axis::List(list) => self.list_dim(*list).map(|dim| (dim, Rule::List)),
                Axis::Subset(subset) => {
                    let subset = self.subset(*subset)?;
                    self.list_dim(subset.list)
                        .map(|dim| (dim, Rule::Subset(subset.items.iter().copied().collect())))
                }
                Axis::Time { level, range } => self
                    .time
                    .filter(|time| time.range == *range)
                    .and_then(|_| self.dim_index(&ViewDim::Time))
                    .map(|dim| {
                        let offset = structure.time_offset(*range);
                        (
                            dim,
                            Rule::Time {
                                level: *level,
                                offset,
                            },
                        )
                    }),
                Axis::Versions => self
                    .dim_index(&ViewDim::Versions)
                    .map(|dim| (dim, Rule::Versions(layout.restriction.clone()))),
                Axis::ListTop(_) => None,
            };
            match planned {
                Some((dim, rule)) => axes.push(PlanAxis { dim, rule }),
                None => in_view = false,
            }
        }
        Ok(LiPlan {
            line_item,
            axes,
            in_view,
            error: self
                .model
                .line_item_errors(id)
                .is_some_and(|errors| !errors.is_empty()),
        })
    }

    /// Whether a version shows the actual version's cells for the period.
    fn before_switchover(
        &self,
        version: VersionId,
        level: TimeLevel,
        period: u32,
        offset: i64,
    ) -> bool {
        let (Some(time), Some(switchover)) = (
            &self.time,
            self.structure
                .version(version)
                .and_then(|version| version.switchover),
        ) else {
            return false;
        };
        offset + i64::from(time.calendar.months_in_period(level, period).end)
            <= i64::from(switchover)
    }

    /// The label of a period as the module's calendar writes it.
    fn period_label(&self, level: TimeLevel, period: u32) -> String {
        self.time
            .map(|time| time.calendar.label(level, period))
            .unwrap_or_default()
    }

    /// The name or label that goes with an item or period value.
    fn text_of(&self, format: &Format, value: &Value) -> Option<String> {
        match (format, value) {
            (Format::List { list }, Value::Item(Some(item))) => {
                let list = self.structure.list(*list)?;
                Some(list.item(list.idx(*item)?).name.clone())
            }
            (_, Value::Period(Some((level, period)))) => {
                Some(self.structure.calendar.label(*level, *period))
            }
            _ => None,
        }
    }

    /// The filters of a query with their line items, if each is fit to filter this view.
    fn filter_plans<'q>(
        &self,
        filters: &'q [RowFilter],
    ) -> Result<Vec<(LiPlan<'a>, &'q RowFilter)>, EngineError> {
        filters
            .iter()
            .map(|filter| {
                let plan = self.plan(filter.line_item)?;
                let name = &plan.line_item.name;
                if !plan.in_view {
                    return Err(invalid(format!(
                        "Filter line item '{name}' has a dimension this view doesn't have."
                    )));
                }
                let compares = matches!(
                    filter.op,
                    FilterOp::Eq
                        | FilterOp::Ne
                        | FilterOp::Lt
                        | FilterOp::Le
                        | FilterOp::Gt
                        | FilterOp::Ge
                        | FilterOp::Contains
                );
                match &filter.value {
                    None if compares => {
                        return Err(invalid(format!("The filter on '{name}' needs a value.")));
                    }
                    Some(value)
                        if filter.op == FilterOp::Contains && !matches!(value, Value::Text(_)) =>
                    {
                        return Err(invalid(format!(
                            "The contains filter on '{name}' needs a text value."
                        )));
                    }
                    _ => {}
                }
                Ok((plan, filter))
            })
            .collect()
    }

    /// The rows that pass the filters, as positions among all rows, or `None` for no filters.
    ///
    /// A filter reads the line item for the members of the row, ignoring the line items
    /// dimension, and for the page's members where the row has none. Dimensions on the columns
    /// are read at their totals and the current version.
    fn filter_rows(
        &self,
        frame: &Frame<'_>,
        filters: &[(LiPlan<'a>, &RowFilter)],
    ) -> Result<Option<Vec<usize>>, EngineError> {
        if filters.is_empty() {
            return Ok(None);
        }
        let rows = frame.rows;
        let lens = rows.lens();
        // The row dimensions that a filter can see: rows that differ only by the others pass or
        // fail together.
        let seen: Vec<usize> = (0..rows.dims.len())
            .filter(|&at| rows.dims[at].dim != ViewDim::LineItems)
            .collect();
        let seen_lens: Vec<usize> = seen.iter().map(|&at| lens[at]).collect();
        let defaults = self.column_defaults();
        let mut passes = vec![true; seen_lens.iter().product()];
        for (plan, filter) in filters {
            let wanted: Vec<usize> = (0..passes.len()).filter(|&at| passes[at]).collect();
            let mut values = vec![blank_value(&plan.line_item.format.value_type()); wanted.len()];
            let mut reads = Vec::new();
            let mut coords = Vec::new();
            for (at, &key) in wanted.iter().enumerate() {
                let picks = split(key, &seen_lens);
                let projection = plan.project(self, |dim| match frame.places[dim] {
                    Place::Row(row_dim) => seen
                        .iter()
                        .position(|&candidate| candidate == row_dim)
                        .map_or(defaults[dim], |seen_at| {
                            rows.dims[row_dim].node(picks[seen_at])
                        }),
                    Place::Column(_) => defaults[dim],
                    Place::Page(page) => frame.pages[page],
                });
                if let Projection::Cell { tokens, .. } = projection
                    && !plan.error
                {
                    reads.push(at);
                    coords.push(tokens);
                }
            }
            if !coords.is_empty() {
                for (at, value) in reads
                    .into_iter()
                    .zip(self.model.read(plan.line_item.id, &coords)?)
                {
                    values[at] = value;
                }
            }
            for (&key, value) in wanted.iter().zip(&values) {
                passes[key] = self.passes(filter, &plan.line_item.format, value);
            }
        }
        let mut passing = Vec::new();
        for at in 0..rows.total() {
            let picks = split(at, &lens);
            let key = seen
                .iter()
                .fold(0, |key, &dim| key * lens[dim] + picks[dim]);
            if passes[key] {
                passing.push(at);
            }
        }
        Ok(Some(passing))
    }

    /// The members a column dimension is read at by a filter: the total of a list, the total
    /// of time and the current version.
    fn column_defaults(&self) -> Vec<Node> {
        self.dims
            .iter()
            .map(|dim| match dim {
                ViewDim::Time => Node::total(Id::Period(TimeLevel::All, 0)),
                ViewDim::Versions => self
                    .structure
                    .versions()
                    .iter()
                    .find(|version| version.is_current)
                    .map_or_else(
                        || Node::total(Id::Top),
                        |version| Node::leaf(Id::Version(version.id)),
                    ),
                ViewDim::LineItems | ViewDim::List { .. } | ViewDim::Subset { .. } => {
                    Node::total(Id::Top)
                }
            })
            .collect()
    }

    /// Whether a cell value passes a filter.
    fn passes(&self, filter: &RowFilter, format: &Format, cell: &Value) -> bool {
        let compared = filter
            .value
            .as_ref()
            .and_then(|wanted| compare(cell, wanted));
        match filter.op {
            FilterOp::Eq => compared == Some(Ordering::Equal),
            FilterOp::Ne => compared != Some(Ordering::Equal),
            FilterOp::Lt => compared == Some(Ordering::Less),
            FilterOp::Le => matches!(compared, Some(Ordering::Less | Ordering::Equal)),
            FilterOp::Gt => compared == Some(Ordering::Greater),
            FilterOp::Ge => matches!(compared, Some(Ordering::Greater | Ordering::Equal)),
            FilterOp::Contains => match (&filter.value, cell) {
                (Some(Value::Text(needle)), Value::Text(text)) => {
                    fold(text).contains(&fold(needle))
                }
                (Some(Value::Text(needle)), item @ Value::Item(Some(_))) => self
                    .text_of(format, item)
                    .is_some_and(|name| fold(&name).contains(&fold(needle))),
                _ => false,
            },
            FilterOp::IsBlank => is_blank(cell),
            FilterOp::NotBlank => !is_blank(cell),
            FilterOp::IsTrue => matches!(cell, Value::Boolean(true)),
            FilterOp::IsFalse => matches!(cell, Value::Boolean(false)),
        }
    }

    /// The cells of a window, reading each line item's cells in one call.
    fn cells(
        &self,
        frame: &Frame<'_>,
        rows: &[Vec<usize>],
        columns: &[Vec<usize>],
    ) -> Result<Vec<Vec<Cell>>, EngineError> {
        // The line items come last among the dimensions.
        let line_item_dim = self.dims.len() - 1;
        let mut cells: Vec<Vec<Option<Cell>>> = rows
            .iter()
            .map(|_| columns.iter().map(|_| None).collect())
            .collect();
        let mut batches: HashMap<LineItemId, Batch<'a>> = HashMap::new();
        for (row_at, row) in rows.iter().enumerate() {
            for (column_at, column) in columns.iter().enumerate() {
                let pick = |dim: usize| frame.node(dim, row, column);
                let Id::LineItem(id) = pick(line_item_dim).id else {
                    continue;
                };
                let batch = match batches.entry(id) {
                    Entry::Occupied(batch) => batch.into_mut(),
                    Entry::Vacant(slot) => slot.insert(Batch::new(self.plan(id)?)),
                };
                let blank = || blank_value(&batch.plan.line_item.format.value_type());
                cells[row_at][column_at] = match batch.plan.project(self, pick) {
                    Projection::Na => Some(Cell {
                        value: blank(),
                        text: None,
                        flags: vec![CellFlag::Readonly, CellFlag::Na],
                    }),
                    Projection::Cell { .. } if batch.plan.error => Some(Cell {
                        value: blank(),
                        text: None,
                        flags: vec![CellFlag::Readonly, CellFlag::Error],
                    }),
                    Projection::Cell {
                        tokens,
                        summary,
                        switchover,
                    } => {
                        batch.targets.push((row_at, column_at));
                        batch.coords.push(tokens);
                        batch
                            .flags
                            .push(cell_flags(batch.plan.line_item, summary, switchover));
                        None
                    }
                };
            }
        }
        for (id, batch) in batches {
            if batch.coords.is_empty() {
                continue;
            }
            let values = self.model.read(id, &batch.coords)?;
            for (((row_at, column_at), value), flags) in
                batch.targets.into_iter().zip(values).zip(batch.flags)
            {
                cells[row_at][column_at] = Some(Cell {
                    text: self.text_of(&batch.plan.line_item.format, &value),
                    value,
                    flags,
                });
            }
        }
        Ok(cells
            .into_iter()
            .map(|row| row.into_iter().flatten().collect())
            .collect())
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
            return Err(invalid(format!(
                "The view lists a line item that isn't in module '{}'.",
                module.name
            )));
        }
        if !seen.insert(*id) {
            return Err(invalid("The view lists a line item more than once."));
        }
    }
    Ok(())
}

/// Adds an item of a list and the items below it to a tree, a parent before its children.
/// `level` counts down from the top of the hierarchy; `children[level]` holds the items of that
/// level's list below each item of the list above.
fn emit_item(
    nodes: &mut Vec<Node>,
    children: &[HashMap<ItemId, Vec<ItemId>>],
    level: usize,
    item: ItemId,
    depth: u8,
    parent: Option<usize>,
) {
    let below = children
        .get(level + 1)
        .and_then(|below| below.get(&item))
        .filter(|below| !below.is_empty());
    let at = nodes.len();
    nodes.push(Node {
        id: Id::Item(item),
        depth,
        summary: level + 1 < children.len(),
        children: below.is_some(),
        parent,
    });
    for child in below.into_iter().flatten() {
        emit_item(
            nodes,
            children,
            level + 1,
            *child,
            depth.saturating_add(1),
            Some(at),
        );
    }
}

/// The level below `level`.
fn finer(level: TimeLevel) -> TimeLevel {
    match level {
        TimeLevel::All => TimeLevel::Year,
        TimeLevel::Year => TimeLevel::HalfYear,
        TimeLevel::HalfYear => TimeLevel::Quarter,
        TimeLevel::Quarter | TimeLevel::Month => TimeLevel::Month,
    }
}

/// Adds a period and the periods it adds up down to `leaf_level` to a tree, the periods
/// before the one they add up. Returns the position of the period.
fn emit_period(
    nodes: &mut Vec<Node>,
    calendar: &Calendar,
    leaf_level: TimeLevel,
    level: TimeLevel,
    period: u32,
) -> usize {
    if level == leaf_level {
        nodes.push(Node::leaf(Id::Period(level, period)));
        return nodes.len() - 1;
    }
    let below = finer(level);
    let per_period = calendar.periods(below) / calendar.periods(level);
    let children: Vec<usize> = (period * per_period..(period + 1) * per_period)
        .map(|child| emit_period(nodes, calendar, leaf_level, below, child))
        .collect();
    let at = nodes.len();
    for child in children {
        nodes[child].parent = Some(at);
    }
    nodes.push(Node {
        depth: level as u8 - leaf_level as u8,
        children: true,
        ..Node::total(Id::Period(level, period))
    });
    at
}

/// Whether a collapsed summary holds the node.
fn under_collapsed(nodes: &[Node], mut at: usize, collapsed: &HashSet<Id>) -> bool {
    if collapsed.is_empty() {
        return false;
    }
    while let Some(parent) = nodes[at].parent {
        if collapsed.contains(&nodes[parent].id) {
            return true;
        }
        at = parent;
    }
    false
}

/// The position along each dimension of the row or column at `linear` among the product of
/// dimensions of lengths `lens`, the last dimension varying fastest.
fn split(mut linear: usize, lens: &[usize]) -> Vec<usize> {
    let mut picks = vec![0; lens.len()];
    for (pick, &len) in picks.iter_mut().zip(lens).rev() {
        *pick = linear % len;
        linear /= len;
    }
    picks
}

/// How the members of one dimension are named.
struct Namer<'a> {
    structure: &'a Structure,
    /// The lists whose items the dimension holds: a list and those above it, or a subset's list.
    lists: Vec<&'a List>,
    top: Option<&'a str>,
    calendar: Option<Calendar>,
}

impl Namer<'_> {
    fn key(&self, id: Id) -> String {
        match id {
            Id::Top => "top".to_string(),
            Id::Item(item) => item.0.to_string(),
            Id::Period(level, period) => self.period_label(level, period),
            Id::Version(version) => version.0.to_string(),
            Id::LineItem(line_item) => line_item.0.to_string(),
        }
    }

    fn label(&self, id: Id) -> String {
        match id {
            Id::Top => self.top.unwrap_or_default().to_string(),
            Id::Item(item) => self
                .lists
                .iter()
                .find_map(|list| list.idx(item).map(|idx| list.item(idx).name.clone()))
                .unwrap_or_default(),
            Id::Period(level, period) => self.period_label(level, period),
            Id::Version(version) => self
                .structure
                .version(version)
                .map(|version| version.name.clone())
                .unwrap_or_default(),
            Id::LineItem(line_item) => self
                .structure
                .line_item(line_item)
                .map(|line_item| line_item.name.clone())
                .unwrap_or_default(),
        }
    }

    fn period_label(&self, level: TimeLevel, period: u32) -> String {
        self.calendar
            .map(|calendar| calendar.label(level, period))
            .unwrap_or_default()
    }

    fn member(&self, node: &Node, collapsed: bool) -> Member {
        Member {
            key: self.key(node.id),
            label: self.label(node.id),
            depth: node.depth,
            is_summary: node.summary,
            has_children: node.children,
            collapsed,
        }
    }
}

/// The members of a dimension that a row or column shows.
struct Shown<'a> {
    dim: ViewDim,
    /// Every member of the dimension.
    nodes: Vec<Node>,
    /// The positions among `nodes` of the members shown, in order.
    shown: Vec<usize>,
    collapsed: HashSet<Id>,
    namer: Namer<'a>,
}

impl Shown<'_> {
    fn node(&self, at: usize) -> Node {
        self.nodes[self.shown[at]]
    }

    fn member(&self, at: usize) -> Member {
        let node = self.node(at);
        self.namer
            .member(&node, node.children && self.collapsed.contains(&node.id))
    }
}

/// The rows or the columns of a view: the product of the members of their dimensions.
struct Side<'a> {
    dims: Vec<Shown<'a>>,
    /// The rows that pass the filters, as positions among all of them.
    passing: Option<Vec<usize>>,
}

impl Side<'_> {
    fn lens(&self) -> Vec<usize> {
        self.dims.iter().map(|dim| dim.shown.len()).collect()
    }

    /// How many rows or columns the dimensions make before filters.
    fn total(&self) -> usize {
        self.dims.iter().map(|dim| dim.shown.len()).product()
    }

    fn count(&self) -> usize {
        self.passing.as_ref().map_or_else(|| self.total(), Vec::len)
    }

    /// The positions among the shown members of each dimension of the row or column `at`.
    fn tuple(&self, at: usize) -> Vec<usize> {
        let linear = self.passing.as_ref().map_or(at, |passing| passing[at]);
        split(linear, &self.lens())
    }

    fn header(&self, tuple: &[usize]) -> Header {
        Header {
            members: self
                .dims
                .iter()
                .zip(tuple)
                .map(|(dim, &at)| dim.member(at))
                .collect(),
        }
    }
}

/// The rows, columns and pages of a query, to find the member of any dimension for a cell.
struct Frame<'a> {
    places: &'a [Place],
    rows: &'a Side<'a>,
    columns: &'a Side<'a>,
    pages: &'a [Node],
}

impl Frame<'_> {
    /// The member of dimension `dim` of the module in the cell at a row and a column, which hold
    /// the positions among the shown members of their dimensions.
    fn node(&self, dim: usize, row: &[usize], column: &[usize]) -> Node {
        match self.places[dim] {
            Place::Row(at) => self.rows.dims[at].node(row[at]),
            Place::Column(at) => self.columns.dims[at].node(column[at]),
            Place::Page(at) => self.pages[at],
        }
    }
}

/// How one axis of a line item takes its member from the view.
enum Rule {
    /// Any member of the list.
    List,
    /// Only members that are in the subset, and any total.
    Subset(HashSet<ItemId>),
    /// Only periods that are not finer than the line item's.
    Time { level: TimeLevel, offset: i64 },
    /// Only versions of the restriction, if there is one.
    Versions(Option<Vec<VersionId>>),
}

struct PlanAxis {
    /// The dimension of the module that gives the axis its member.
    dim: usize,
    rule: Rule,
}

/// How the cells of a line item line up with the dimensions of the view.
struct LiPlan<'a> {
    line_item: &'a LineItem,
    axes: Vec<PlanAxis>,
    /// Whether every axis of the line item is a dimension of the view.
    in_view: bool,
    error: bool,
}

/// The cell of a line item for a combination of members.
enum Projection {
    /// The line item has no cell here.
    Na,
    Cell {
        tokens: Vec<CoordToken>,
        summary: bool,
        switchover: bool,
    },
}

impl LiPlan<'_> {
    /// The cell for the members `pick` gives for each dimension of the module. A dimension the
    /// line item lacks is ignored, and the cell is the same for each of its members.
    fn project(&self, cx: &Cx<'_>, pick: impl Fn(usize) -> Node) -> Projection {
        if !self.in_view {
            return Projection::Na;
        }
        let mut tokens = Vec::with_capacity(self.axes.len());
        let mut summary = false;
        let mut period = None;
        let mut version = None;
        for axis in &self.axes {
            let node = pick(axis.dim);
            match (&axis.rule, node.id) {
                (Rule::List | Rule::Subset(_), Id::Top) => {
                    tokens.push(CoordToken::Period("top".to_string()));
                    summary = true;
                }
                (Rule::List, Id::Item(item)) => {
                    tokens.push(CoordToken::Item(item));
                    summary |= node.summary;
                }
                (Rule::Subset(members), Id::Item(item)) => {
                    if !node.summary && !members.contains(&item) {
                        return Projection::Na;
                    }
                    tokens.push(CoordToken::Item(item));
                    summary |= node.summary;
                }
                (Rule::Time { level, offset }, Id::Period(found, index)) => {
                    if found < *level {
                        return Projection::Na;
                    }
                    summary |= found > *level;
                    tokens.push(CoordToken::Period(cx.period_label(found, index)));
                    period = Some((found, index, *offset));
                }
                (Rule::Versions(only), Id::Version(id)) => {
                    if only.as_ref().is_some_and(|only| !only.contains(&id)) {
                        return Projection::Na;
                    }
                    tokens.push(CoordToken::Item(ItemId(id.0)));
                    version = Some(id);
                }
                _ => return Projection::Na,
            }
        }
        let switchover = match (summary, period, version) {
            (false, Some((level, index, offset)), Some(version)) => {
                cx.before_switchover(version, level, index, offset)
            }
            _ => false,
        };
        Projection::Cell {
            tokens,
            summary,
            switchover,
        }
    }
}

/// The cells of one line item that a window reads.
struct Batch<'a> {
    plan: LiPlan<'a>,
    /// The row and column of each cell in the window.
    targets: Vec<(usize, usize)>,
    coords: Vec<Vec<CoordToken>>,
    flags: Vec<Vec<CellFlag>>,
}

impl<'a> Batch<'a> {
    fn new(plan: LiPlan<'a>) -> Batch<'a> {
        Batch {
            plan,
            targets: Vec::new(),
            coords: Vec::new(),
            flags: Vec::new(),
        }
    }
}

/// The flags of a cell that is not blank for want of a cell or a formula that works.
fn cell_flags(line_item: &LineItem, summary: bool, switchover: bool) -> Vec<CellFlag> {
    match (summary, line_item.formula.is_some(), switchover) {
        (true, _, _) => vec![CellFlag::Summary, CellFlag::Readonly],
        (false, true, false) => vec![CellFlag::Calculated, CellFlag::Readonly],
        (false, true, true) => vec![
            CellFlag::Calculated,
            CellFlag::Readonly,
            CellFlag::Switchover,
        ],
        (false, false, false) => vec![CellFlag::Input],
        (false, false, true) => vec![CellFlag::Readonly, CellFlag::Switchover],
    }
}

/// How a cell compares with the value a filter wants, if they can be compared.
fn compare(cell: &Value, wanted: &Value) -> Option<Ordering> {
    match (cell, wanted) {
        (Value::Number(a), Value::Number(b)) => a.partial_cmp(b),
        (Value::Boolean(a), Value::Boolean(b)) => Some(a.cmp(b)),
        (Value::Text(a), Value::Text(b)) => Some(fold(a).cmp(&fold(b))),
        (Value::Date(a), Value::Date(b)) => Some(a.cmp(b)),
        (Value::Item(a), Value::Item(b)) => (a == b).then_some(Ordering::Equal),
        (Value::Period(a), Value::Period(b)) => (a == b).then_some(Ordering::Equal),
        _ => None,
    }
}

/// Whether a value is the blank one of its type.
fn is_blank(value: &Value) -> bool {
    match value {
        Value::Number(number) => *number == 0.0,
        Value::Boolean(flag) => !flag,
        Value::Text(text) => text.is_empty(),
        Value::Date(date) => date.is_none(),
        Value::Item(item) => item.is_none(),
        Value::Period(period) => period.is_none(),
    }
}
