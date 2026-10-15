use super::members::{Frame, Id, Node};
use super::{Cell, CellFlag, Cx, LineItemInfo, ViewDim, not_found};
use crate::calendar::TimeLevel;
use crate::command::CoordToken;
use crate::error::{EngineError, FormulaError};
use crate::ids::{ItemId, LineItemId, ListId, TimeRangeId, VersionId};
use crate::model::blank_value;
use crate::shape::Axis;
use crate::structure::LineItem;
use crate::value::{Format, Value};
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

/// How one axis of a line item takes its member from the view.
enum Rule {
    /// Any member of the list.
    List,
    /// Only members that are in the subset, and any total.
    Subset(HashSet<ItemId>),
    /// Only periods that are not finer than the line item's.
    Time {
        level: TimeLevel,
        range: Option<TimeRangeId>,
    },
    /// Only versions of the restriction, if there is one.
    Versions(Option<Vec<VersionId>>),
}

struct PlanAxis {
    /// The dimension of the module that gives the axis its member.
    dim: usize,
    rule: Rule,
}

/// How the cells of a line item line up with the dimensions of the view.
pub(super) struct LiPlan<'a> {
    pub(super) line_item: &'a LineItem,
    axes: Vec<PlanAxis>,
    /// Whether every axis of the line item is a dimension of the view.
    pub(super) in_view: bool,
    pub(super) error: bool,
}

/// The cell of a line item for a combination of members.
pub(super) enum Projection {
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
    pub(super) fn project(&self, cx: &Cx<'_>, pick: impl Fn(usize) -> Node) -> Projection {
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
                (Rule::Time { level, range }, Id::Period(found, index)) => {
                    if found < *level {
                        return Projection::Na;
                    }
                    summary |= found > *level;
                    tokens.push(CoordToken::Period(cx.period_label(found, index)));
                    period = Some((found, index, *range));
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
            (false, Some((level, index, range)), Some(version)) => {
                cx.structure.before_switchover(version, level, range, index)
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
}

impl<'a> Batch<'a> {
    fn new(plan: LiPlan<'a>) -> Batch<'a> {
        Batch {
            plan,
            targets: Vec::new(),
            coords: Vec::new(),
        }
    }
}

impl<'a> Cx<'a> {
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

    pub(super) fn line_item_infos(&self) -> Result<Vec<LineItemInfo>, EngineError> {
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
    pub(super) fn plan(&self, id: LineItemId) -> Result<LiPlan<'a>, EngineError> {
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
                        (
                            dim,
                            Rule::Time {
                                level: *level,
                                range: *range,
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

    /// The label of a period as the module's calendar writes it.
    fn period_label(&self, level: TimeLevel, period: u32) -> String {
        self.time
            .map(|time| time.calendar.label(level, period))
            .unwrap_or_default()
    }

    /// The name or label that goes with an item or period value.
    pub(super) fn text_of(&self, format: &Format, value: &Value) -> Option<String> {
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

    /// The cells of a window, reading each line item's cells in one call.
    pub(super) fn cells(
        &self,
        frame: &Frame<'_>,
        rows: &[Vec<usize>],
        columns: &[Vec<usize>],
    ) -> Result<Vec<Vec<Cell>>, EngineError> {
        // The line items come last among the dimensions.
        let line_item_dim = self.dims.len() - 1;
        let mut batches: HashMap<LineItemId, Batch<'a>> = HashMap::new();
        let mut cells = Vec::with_capacity(rows.len());
        for (row_at, row) in rows.iter().enumerate() {
            let mut cells_of_row = Vec::with_capacity(columns.len());
            for (column_at, column) in columns.iter().enumerate() {
                let pick = |dim: usize| frame.node(dim, row, column);
                let Id::LineItem(id) = pick(line_item_dim).id else {
                    unreachable!("the line items dimension holds line items");
                };
                let batch = match batches.entry(id) {
                    Entry::Occupied(batch) => batch.into_mut(),
                    Entry::Vacant(slot) => slot.insert(Batch::new(self.plan(id)?)),
                };
                let format = &batch.plan.line_item.format;
                cells_of_row.push(match batch.plan.project(self, pick) {
                    Projection::Na => blank_cell(format, vec![CellFlag::Readonly, CellFlag::Na]),
                    Projection::Cell { .. } if batch.plan.error => {
                        blank_cell(format, vec![CellFlag::Readonly, CellFlag::Error])
                    }
                    Projection::Cell {
                        tokens,
                        summary,
                        switchover,
                    } => {
                        batch.targets.push((row_at, column_at));
                        batch.coords.push(tokens);
                        // Blank until the cells of the line item are read.
                        blank_cell(
                            format,
                            cell_flags(batch.plan.line_item, summary, switchover),
                        )
                    }
                });
            }
            cells.push(cells_of_row);
        }
        for (id, batch) in batches {
            if batch.coords.is_empty() {
                continue;
            }
            let values = self.model.read(id, &batch.coords)?;
            for ((row_at, column_at), value) in batch.targets.into_iter().zip(values) {
                let cell = &mut cells[row_at][column_at];
                cell.text = self.text_of(&batch.plan.line_item.format, &value);
                cell.value = value;
            }
        }
        Ok(cells)
    }
}

/// A cell with the blank value of a format.
fn blank_cell(format: &Format, flags: Vec<CellFlag>) -> Cell {
    Cell {
        value: blank_value(&format.value_type()),
        text: None,
        flags,
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
