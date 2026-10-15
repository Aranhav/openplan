//! The dimensions of the cell being calculated: `ITEM(Products)`, `ITEM(Versions)` and
//! `ITEM(Time)`.

use crate::calendar::TimeLevel;
use crate::error::{EngineError, FormulaError};
use crate::ids::ListId;
use crate::shape::{Axis, Shape};
use crate::structure::Structure;
use crate::value::{BLANK_ITEM, BLANK_PERIOD, Column};

use crate::formula::{DIMENSION, EvalCtx, Span, TExpr};

/// Checks that the line item has the dimension `ITEM` asks for.
pub(super) fn check_item(ctx: &EvalCtx, target: &Shape, args: &[TExpr]) -> Result<(), EngineError> {
    item_axis(ctx.structure, target, args).map(|_| ())
}

/// The position on `target` of the axis `ITEM(dimension)` names, or the error that the line item
/// has no such dimension. Which axes a line item has depends on the structure only, so this is
/// checked before any cell is evaluated.
fn item_axis(structure: &Structure, target: &Shape, args: &[TExpr]) -> Result<usize, EngineError> {
    let (axis, name, span) = match args {
        [TExpr::ListRef { list, span }] if *list == ListId::VERSIONS => {
            (target.axis_pos(&Axis::Versions), "Versions", *span)
        }
        [TExpr::ListRef { list, span }] => (
            target
                .axes
                .iter()
                .position(|axis| list_of_axis(structure, axis) == Some(*list)),
            structure.list_name(*list),
            *span,
        ),
        [TExpr::TimeRef { span, .. }] => (target.time_pos(), "Time", *span),
        _ => {
            return Err(EngineError::Invalid {
                message: "ITEM takes the name of a dimension.".to_string(),
            });
        }
    };
    axis.ok_or_else(|| missing_dimension(name, span))
}

/// `ITEM(dimension)`: the item, version or period the target cell sits at on that axis.
///
/// An item of a list is its dense index, a version its position among all versions of the
/// model, and a period its index at the line item's time level on the model calendar.
pub(super) fn eval_item(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let structure = ctx.structure;
    let axis = item_axis(structure, target, args)?;
    let (stride, len) = (target.strides[axis], target.lens[axis] as usize);
    let coords = idx.iter().map(|&i| (i / stride % len) as u32);
    Ok(match &target.axes[axis] {
        Axis::List(_) => Column::Item(coords.collect()),
        Axis::Subset(id) => {
            let subset = structure.subset(*id);
            let list = subset.and_then(|subset| structure.list(subset.list));
            Column::Item(
                coords
                    .map(|coord| {
                        subset
                            .and_then(|subset| subset.items.get(coord as usize))
                            .zip(list)
                            .and_then(|(item, list)| list.idx(*item))
                            .unwrap_or(BLANK_ITEM)
                    })
                    .collect(),
            )
        }
        Axis::Versions => Column::Item(coords.map(|coord| version_position(ctx, coord)).collect()),
        Axis::Time { level, range } => {
            let calendar = structure.time_calendar(*range)?;
            let offset = range
                .and_then(|id| structure.time_range(id))
                .map_or(0, |range| structure.calendar.range_month_offset(range));
            Column::Period(
                coords
                    .map(|coord| {
                        let first =
                            offset + i64::from(calendar.months_in_period(*level, coord).start);
                        period_on_model_calendar(structure, *level, first)
                    })
                    .collect(),
            )
        }
        Axis::ListTop(_) => {
            return Err(EngineError::Invalid {
                message: "A line item has no top-level axis.".to_string(),
            });
        }
    })
}

/// The list a list or subset axis is made of.
fn list_of_axis(structure: &Structure, axis: &Axis) -> Option<ListId> {
    match axis {
        Axis::List(list) => Some(*list),
        Axis::Subset(subset) => structure.subset(*subset).map(|subset| subset.list),
        _ => None,
    }
}

/// The position among all versions of the model of the version at `coord` of the target's
/// Versions axis, which spans only some of them if the line item is restricted.
fn version_position(ctx: &EvalCtx, coord: u32) -> u32 {
    let versions = ctx.structure.versions();
    let id = match ctx.layout.restriction.as_deref() {
        Some(only) => only.get(coord as usize).copied(),
        None => versions.get(coord as usize).map(|version| version.id),
    };
    id.and_then(|id| versions.iter().position(|version| version.id == id))
        .map_or(BLANK_ITEM, |position| position as u32)
}

/// The index at `level` of the period that holds the month `first_month` counted from the
/// start of the model calendar; blank outside the calendar.
fn period_on_model_calendar(structure: &Structure, level: TimeLevel, first_month: i64) -> u32 {
    u32::try_from(first_month)
        .ok()
        .filter(|&month| month < structure.calendar.months())
        .map_or(BLANK_PERIOD, |month| {
            structure.calendar.period_of_month(month, level)
        })
}

fn missing_dimension(name: &str, span: Span) -> EngineError {
    EngineError::Formula(vec![FormulaError {
        code: DIMENSION,
        message: format!("This formula's line item has no '{name}' dimension."),
        start: span.start,
        end: span.end,
        suggestion: None,
    }])
}
