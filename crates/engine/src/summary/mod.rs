//! Summaries: rolling a grid of cells up to coarser hierarchy and time levels.

use std::borrow::Cow;

use crate::error::EngineError;
use crate::ids::{LineItemId, ListId};
use crate::shape::{Axis, Shape};
use crate::structure::{LineItem, List, Structure, SummaryMethod, level_name};
use crate::value::Column;

mod cache;

pub(crate) use cache::{Summary, SummaryCache};

/// The levels a grid is summarized to: one axis per axis of the source shape, in the same
/// order.
///
/// A list axis becomes the axis of an ancestor list (`Axis::List`) or the single total item
/// of that list or of one of its ancestors (`Axis::ListTop`); a subset axis does likewise,
/// but cannot become its own list. A Time axis becomes a coarser level of the same time
/// range. A Versions axis stays as it is.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct LevelSpec(pub Vec<Axis>);

/// Rolls a grid of cells up to the coarser `target` levels.
///
/// Every target cell is computed straight from the leaf cells it covers, so an average is the
/// average of the leaves and not an average of averages. Time is rolled up first, with
/// `time_method`, and the list axes then with `method`:
///
/// - `Sum`, `Min`, `Max`, `Any` and `All` combine the cells. `Min` and `Max` take blank
///   cells into account as zero. Empty groups, such as a parent without live children,
///   come out blank.
/// - `Average` divides the sum by the number of cells.
/// - `Ratio` divides the sum of the numerator cells by the sum of the denominator cells, or
///   gives 0 when that is 0. `ratio_parts` holds both columns, laid out over `src_shape`;
///   they are summed along every axis, whatever the method of the other axis.
/// - `First`, `Last`, `Opening` and `Closing` take the first or last cell of the period
///   along Time (`First` and `Opening` are the same, as are `Last` and `Closing`) and
///   add up along list axes.
/// - `None` makes every rolled-up cell blank.
///
/// `Formula` summaries are evaluated by the formula engine and are rejected here, for a column
/// of any type, as soon as a roll-up step uses one. Number
/// columns take every method but `Any` and `All`, which, like `None`, make them blank; boolean
/// columns take `Any`, `All` and the positional methods along Time, and other methods make
/// them blank; text, date, list and period columns are always blank once rolled up.
/// Axes that stay as they are do not change a column, so the result of a target without any
/// coarser axis is the source itself.
pub fn aggregate(
    structure: &Structure,
    src_shape: &Shape,
    src: &Column,
    method: &SummaryMethod,
    time_method: &SummaryMethod,
    target: &LevelSpec,
    ratio_parts: Option<(&Column, &Column)>,
) -> Result<(Shape, Column), EngineError> {
    let plan = Plan::new(structure, src_shape, target)?;
    if src.len() != src_shape.size() {
        return Err(invalid(format!(
            "The column has {} cells but its shape has {}.",
            src.len(),
            src_shape.size()
        )));
    }
    let out_shape = Shape::new(
        target.0.clone(),
        plan.axes.iter().map(|axis| axis.group.out_len).collect(),
    );
    let mut steps = Vec::new();
    if plan.time_reduces() {
        steps.push((Phase::Time, time_method));
    }
    if plan.lists_reduce() {
        steps.push((Phase::Lists, method));
    }
    if steps.is_empty() {
        return Ok((out_shape, src.clone()));
    }

    let boolean = matches!(src, Column::Boolean(_));
    let reducers = steps
        .into_iter()
        .map(|(phase, method)| Ok((phase, reducer_for(method, phase == Phase::Time, boolean)?)))
        .collect::<Result<Vec<_>, EngineError>>()?;
    let numbers = match src {
        Column::Number(cells) => Some(Cow::Borrowed(cells.as_slice())),
        Column::Boolean(cells) => Some(Cow::Owned(
            cells
                .iter()
                .map(|&cell| f64::from(u8::from(cell)))
                .collect(),
        )),
        _ => None,
    };
    let steps: Option<Vec<(Phase, Reducer)>> = reducers
        .into_iter()
        .map(|(phase, reducer)| reducer.map(|reducer| (phase, reducer)))
        .collect();
    let (Some(values), Some(steps)) = (numbers, steps) else {
        return Ok(blank(out_shape, src));
    };
    let parts = if steps.iter().any(|(_, reducer)| *reducer == Reducer::Ratio) {
        Some(number_parts(src, ratio_parts)?)
    } else {
        None
    };

    let mut shape = src_shape.clone();
    let mut state = Series { values, parts };
    for (index, &(phase, reducer)) in steps.iter().enumerate() {
        let keep_parts = steps[index + 1..]
            .iter()
            .any(|(_, later)| *later == Reducer::Ratio);
        let groups = plan.groups(phase, &shape.lens);
        let axes = plan
            .axes
            .iter()
            .zip(&shape.axes)
            .map(|(planned, current)| {
                if phase.owns(&planned.target) {
                    planned.target.clone()
                } else {
                    current.clone()
                }
            })
            .collect();
        let next = Shape::new(axes, groups.iter().map(|group| group.out_len).collect());
        state = reduce(&shape, &next, &groups, &state, reducer, keep_parts);
        shape = next;
    }
    let column = match src {
        Column::Boolean(_) => {
            Column::Boolean(state.values.iter().map(|&value| value != 0.0).collect())
        }
        _ => Column::Number(state.values.into_owned()),
    };
    Ok((out_shape, column))
}

fn blank(shape: Shape, like: &Column) -> (Shape, Column) {
    let column = like.blank_like(shape.size());
    (shape, column)
}

/// The numerator and denominator columns of a ratio, checked against the source column.
fn number_parts<'a>(
    src: &Column,
    parts: Option<(&'a Column, &'a Column)>,
) -> Result<Parts<'a>, EngineError> {
    match parts {
        Some((Column::Number(numerator), Column::Number(denominator)))
            if numerator.len() == src.len() && denominator.len() == src.len() =>
        {
            Ok((Cow::Borrowed(numerator), Cow::Borrowed(denominator)))
        }
        _ => Err(invalid(
            "A ratio summary needs a numerator and a denominator number column with the same cells as the line item.",
        )),
    }
}

/// The line items whose cells a line item's ratio summary adds up, if it has one.
pub(crate) fn ratio_parts(
    line_item: &LineItem,
) -> Result<Option<(LineItemId, LineItemId)>, EngineError> {
    let parts = |method: &SummaryMethod| match method {
        SummaryMethod::Ratio {
            numerator,
            denominator,
        } => Some((*numerator, *denominator)),
        _ => None,
    };
    match (
        parts(&line_item.summary),
        line_item.time_summary.as_ref().and_then(parts),
    ) {
        (Some(summary), Some(time)) if summary != time => Err(invalid(format!(
            "The summary and time summary of line item '{}' must divide the same line items.",
            line_item.name
        ))),
        (summary, time) => Ok(summary.or(time)),
    }
}

/// Which axes a step of the roll-up combines.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Time,
    Lists,
}

impl Phase {
    fn owns(self, axis: &Axis) -> bool {
        matches!(axis, Axis::Time { .. }) == (self == Phase::Time)
    }
}

/// How the cells that land in one target cell combine into a value of their own.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fold {
    Sum,
    Average,
    Min,
    Max,
    First,
    Last,
}

/// How the cells that land in one target cell combine.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Reducer {
    Fold(Fold),
    /// The sum of the numerators over the sum of the denominators.
    Ratio,
}

/// The reducer of a summary method over a number column, or over a boolean column held as
/// zeros and ones; `None` when the method leaves every rolled-up cell blank.
fn reducer_for(
    method: &SummaryMethod,
    along_time: bool,
    boolean: bool,
) -> Result<Option<Reducer>, EngineError> {
    use SummaryMethod as M;
    let positional = |along: Fold| {
        if along_time {
            Some(along)
        } else {
            (!boolean).then_some(Fold::Sum)
        }
    };
    let fold = match (method, boolean) {
        (M::Formula, _) => {
            return Err(invalid(
                "Formula summaries are evaluated by the formula engine and cannot be aggregated.",
            ));
        }
        (M::Ratio { .. }, false) => return Ok(Some(Reducer::Ratio)),
        (M::Sum, false) => Some(Fold::Sum),
        (M::Average, false) => Some(Fold::Average),
        (M::Min, false) | (M::All, true) => Some(Fold::Min),
        (M::Max, false) | (M::Any, true) => Some(Fold::Max),
        (M::First | M::Opening, _) => positional(Fold::First),
        (M::Last | M::Closing, _) => positional(Fold::Last),
        _ => None,
    };
    Ok(fold.map(Reducer::Fold))
}

/// The numerator and denominator cells of a ratio.
type Parts<'a> = (Cow<'a, [f64]>, Cow<'a, [f64]>);

/// The cells of a step of the roll-up, with the sums of the ratio parts when they are needed.
struct Series<'a> {
    values: Cow<'a, [f64]>,
    parts: Option<Parts<'a>>,
}

/// Combines the cells of `input`, laid out over `from`, into the cells of `to` that `groups`
/// send them to. Cells are visited in order, so `First` and `Last` see them in time order.
///
/// Ratio parts, when the input has them, are summed if the reducer is `Ratio` or `keep_parts`
/// is set; the sums are returned only for `keep_parts`.
fn reduce<'a>(
    from: &Shape,
    to: &Shape,
    groups: &[Group],
    input: &Series<'_>,
    reducer: Reducer,
    keep_parts: bool,
) -> Series<'a> {
    let offsets: Vec<Vec<Option<usize>>> = groups
        .iter()
        .zip(&to.strides)
        .map(|(group, &stride)| {
            group
                .positions
                .iter()
                .map(|position| position.map(|position| position as usize * stride))
                .collect()
        })
        .collect();
    let size = to.size();
    let sums = input
        .parts
        .as_ref()
        .filter(|_| keep_parts || reducer == Reducer::Ratio)
        .map(|(numerator, denominator)| {
            let mut numerators = vec![0.0; size];
            let mut denominators = vec![0.0; size];
            walk(&from.lens, &offsets, &mut |src, dst| {
                numerators[dst] += numerator[src];
                denominators[dst] += denominator[src];
            });
            (numerators, denominators)
        });
    let values = match (reducer, &sums) {
        (Reducer::Fold(fold), _) => fold_cells(fold, &from.lens, &offsets, &input.values, size),
        (Reducer::Ratio, Some((numerators, denominators))) => numerators
            .iter()
            .zip(denominators)
            .map(|(&numerator, &denominator)| {
                if denominator == 0.0 {
                    0.0
                } else {
                    numerator / denominator
                }
            })
            .collect(),
        (Reducer::Ratio, None) => {
            unreachable!("a ratio step is only planned together with its ratio parts")
        }
    };
    Series {
        values: Cow::Owned(values),
        parts: sums
            .filter(|_| keep_parts)
            .map(|(numerators, denominators)| (Cow::Owned(numerators), Cow::Owned(denominators))),
    }
}

/// Combines the cells of `values` that land in one target cell with `fold`; target cells that
/// no cell lands in come out as 0.
fn fold_cells(
    fold: Fold,
    lens: &[u32],
    offsets: &[Vec<Option<usize>>],
    values: &[f64],
    size: usize,
) -> Vec<f64> {
    let mut out = vec![0.0; size];
    let mut counts = vec![0u32; size];
    match fold {
        Fold::Sum => walk(lens, offsets, &mut |src, dst| out[dst] += values[src]),
        Fold::Average => {
            walk(lens, offsets, &mut |src, dst| {
                out[dst] += values[src];
                counts[dst] += 1;
            });
            for (cell, &count) in out.iter_mut().zip(&counts) {
                if count > 0 {
                    *cell /= f64::from(count);
                }
            }
        }
        Fold::Min => walk(lens, offsets, &mut |src, dst| {
            if counts[dst] == 0 || values[src] < out[dst] {
                out[dst] = values[src];
            }
            counts[dst] += 1;
        }),
        Fold::Max => walk(lens, offsets, &mut |src, dst| {
            if counts[dst] == 0 || values[src] > out[dst] {
                out[dst] = values[src];
            }
            counts[dst] += 1;
        }),
        Fold::First => walk(lens, offsets, &mut |src, dst| {
            if counts[dst] == 0 {
                out[dst] = values[src];
            }
            counts[dst] += 1;
        }),
        Fold::Last => walk(lens, offsets, &mut |src, dst| out[dst] = values[src]),
    }
    out
}

/// Calls `visit(source index, target index)` for every source cell that is not dropped, in
/// source order. `offsets[axis][position]` is the target offset a position along an axis adds,
/// or `None` for a dropped one.
fn walk(lens: &[u32], offsets: &[Vec<Option<usize>>], visit: &mut impl FnMut(usize, usize)) {
    fn descend(
        depth: usize,
        source: usize,
        target: usize,
        lens: &[u32],
        offsets: &[Vec<Option<usize>>],
        visit: &mut impl FnMut(usize, usize),
    ) {
        let base = source * lens[depth] as usize;
        let reachable = offsets[depth]
            .iter()
            .enumerate()
            .filter_map(|(position, offset)| offset.map(|offset| (position, offset)));
        if depth + 1 == lens.len() {
            for (position, offset) in reachable {
                visit(base + position, target + offset);
            }
        } else {
            for (position, offset) in reachable {
                descend(
                    depth + 1,
                    base + position,
                    target + offset,
                    lens,
                    offsets,
                    visit,
                );
            }
        }
    }
    debug_assert!(!lens.is_empty(), "only grids with axes are rolled up");
    descend(0, 0, 0, lens, offsets, visit);
}

/// Where the positions along one source axis land on its target axis.
#[derive(Clone)]
struct Group {
    /// Target position of every source position; `None` drops the cell.
    positions: Vec<Option<u32>>,
    out_len: u32,
}

impl Group {
    fn identity(len: u32) -> Group {
        Group {
            positions: (0..len).map(Some).collect(),
            out_len: len,
        }
    }
}

struct AxisPlan {
    target: Axis,
    group: Group,
    /// Whether the cells along this axis combine into fewer.
    reduces: bool,
}

/// How each axis of a source shape maps onto the target levels.
struct Plan {
    axes: Vec<AxisPlan>,
}

impl Plan {
    fn new(
        structure: &Structure,
        src_shape: &Shape,
        target: &LevelSpec,
    ) -> Result<Plan, EngineError> {
        if target.0.len() != src_shape.axes.len() {
            return Err(invalid(format!(
                "The levels need one axis for each of the {} axes of the grid but have {}.",
                src_shape.axes.len(),
                target.0.len()
            )));
        }
        let axes = src_shape
            .axes
            .iter()
            .zip(&src_shape.lens)
            .zip(&target.0)
            .map(|((source, &len), wanted)| plan_axis(structure, source, len, wanted))
            .collect::<Result<_, _>>()?;
        Ok(Plan { axes })
    }

    fn time_reduces(&self) -> bool {
        self.axes
            .iter()
            .any(|axis| Phase::Time.owns(&axis.target) && axis.reduces)
    }

    fn lists_reduce(&self) -> bool {
        self.axes
            .iter()
            .any(|axis| Phase::Lists.owns(&axis.target) && axis.reduces)
    }

    /// The groups of a step whose input has the lengths `lens`: the planned ones for the
    /// axes the step combines, no change for the others.
    fn groups(&self, phase: Phase, lens: &[u32]) -> Vec<Group> {
        self.axes
            .iter()
            .zip(lens)
            .map(|(axis, &len)| {
                if phase.owns(&axis.target) {
                    axis.group.clone()
                } else {
                    Group::identity(len)
                }
            })
            .collect()
    }
}

fn plan_axis(
    structure: &Structure,
    source: &Axis,
    len: u32,
    wanted: &Axis,
) -> Result<AxisPlan, EngineError> {
    let planned = |group: Group, reduces: bool| AxisPlan {
        target: wanted.clone(),
        group,
        reduces,
    };
    let plan = match (source, wanted) {
        (Axis::Versions, Axis::Versions) => planned(Group::identity(len), false),
        (
            Axis::Time { level, range },
            Axis::Time {
                level: coarser,
                range: same_range,
            },
        ) if range == same_range && coarser >= level => {
            let calendar = structure.time_calendar(*range)?;
            let positions = (0..calendar.periods(*level))
                .map(|period| {
                    let first_month = calendar.months_in_period(*level, period).start;
                    Some(calendar.period_of_month(first_month, *coarser))
                })
                .collect();
            let group = Group {
                positions,
                out_len: calendar.periods(*coarser),
            };
            planned(group, coarser > level)
        }
        (Axis::ListTop(list), Axis::ListTop(top)) if ancestors(structure, *list)?.contains(top) => {
            planned(Group::identity(1), false)
        }
        (Axis::List(list), _) => {
            let from = list_of(structure, *list)?;
            let live = (0..from.len_dense())
                .map(|idx| (!from.item(idx).deleted).then_some(idx))
                .collect();
            plan_list_axis(structure, source, *list, live, wanted)?
        }
        (Axis::Subset(id), _) => {
            let subset = structure
                .subset(*id)
                .ok_or_else(|| not_found("subset", id.0))?;
            let from = list_of(structure, subset.list)?;
            let members = subset.items.iter().map(|item| from.idx(*item)).collect();
            plan_list_axis(structure, source, subset.list, members, wanted)?
        }
        _ => return Err(unsupported(structure, source, wanted)),
    };
    if plan.group.positions.len() != len as usize {
        return Err(invalid(format!(
            "The grid has {len} positions along {} but the model has {}.",
            describe(structure, source),
            plan.group.positions.len()
        )));
    }
    Ok(plan)
}

/// Plans a list or subset axis whose cells sit at the dense positions `start` of `list` (or
/// its subset's list).
fn plan_list_axis(
    structure: &Structure,
    source: &Axis,
    list: ListId,
    start: Vec<Option<u32>>,
    wanted: &Axis,
) -> Result<AxisPlan, EngineError> {
    let chain = ancestors(structure, list)?;
    let planned = |positions, out_len, reduces| AxisPlan {
        target: wanted.clone(),
        group: Group { positions, out_len },
        reduces,
    };
    let len = start.len() as u32;
    match wanted {
        Axis::ListTop(top) if chain.contains(top) => {
            let positions = start.iter().map(|position| position.map(|_| 0)).collect();
            Ok(planned(positions, 1, true))
        }
        Axis::List(to) if matches!(source, Axis::List(_)) && *to == list => {
            Ok(planned(start, len, false))
        }
        Axis::Subset(_) if wanted == source => {
            let positions = start
                .iter()
                .enumerate()
                .map(|(position, member)| member.map(|_| position as u32))
                .collect();
            Ok(planned(positions, len, false))
        }
        Axis::List(to) if chain[1..].contains(to) => {
            let positions = lift(structure, list, *to, start)?;
            let out_len = list_of(structure, *to)?.len_dense();
            Ok(planned(positions, out_len, true))
        }
        _ => Err(unsupported(structure, source, wanted)),
    }
}

fn unsupported(structure: &Structure, source: &Axis, wanted: &Axis) -> EngineError {
    invalid(format!(
        "Cannot summarize {} to {}.",
        describe(structure, source),
        describe(structure, wanted)
    ))
}

/// A list followed by each list above it in the hierarchy.
fn ancestors(structure: &Structure, list: ListId) -> Result<Vec<ListId>, EngineError> {
    let mut chain = vec![list];
    let mut current = list_of(structure, list)?;
    while let Some(parent) = current.parent {
        chain.push(parent);
        current = list_of(structure, parent)?;
    }
    Ok(chain)
}

/// Moves dense positions of list `from` up to the dense positions of their ancestors in
/// `to`, which is above `from`.
fn lift(
    structure: &Structure,
    from: ListId,
    to: ListId,
    mut positions: Vec<Option<u32>>,
) -> Result<Vec<Option<u32>>, EngineError> {
    let mut current = from;
    while current != to {
        let list = list_of(structure, current)?;
        let parent_id = list
            .parent
            .ok_or_else(|| invalid(format!("List '{}' has no parent list.", list.name)))?;
        let parent = list_of(structure, parent_id)?;
        let step = (0..list.len_dense())
            .map(|idx| {
                let item = list.item(idx);
                if item.deleted {
                    return Ok(None);
                }
                item.parent
                    .and_then(|parent_item| parent.idx(parent_item))
                    .map(Some)
                    .ok_or_else(|| {
                        invalid(format!(
                            "Item '{}' has no parent item in list '{}'.",
                            item.name, parent.name
                        ))
                    })
            })
            .collect::<Result<Vec<Option<u32>>, EngineError>>()?;
        for position in &mut positions {
            *position = position.and_then(|position| step[position as usize]);
        }
        current = parent_id;
    }
    Ok(positions)
}

fn list_of(structure: &Structure, id: ListId) -> Result<&List, EngineError> {
    structure.list(id).ok_or_else(|| not_found("list", id.0))
}

fn describe(structure: &Structure, axis: &Axis) -> String {
    let list_name = |id: ListId| structure.list(id).map_or("?", |list| list.name.as_str());
    match axis {
        Axis::List(id) => format!("list '{}'", list_name(*id)),
        Axis::ListTop(id) => format!("the top level of list '{}'", list_name(*id)),
        Axis::Subset(id) => format!(
            "subset '{}'",
            structure
                .subset(*id)
                .map_or("?", |subset| subset.name.as_str())
        ),
        Axis::Time { level, .. } => format!("{} periods", level_name(*level)),
        Axis::Versions => "versions".to_string(),
    }
}

fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::Invalid {
        message: message.into(),
    }
}

fn not_found(what: &'static str, id: uuid::Uuid) -> EngineError {
    EngineError::NotFound {
        what,
        id: id.to_string(),
    }
}
