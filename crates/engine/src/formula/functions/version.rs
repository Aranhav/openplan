//! `CURRENTVERSION`, `PREVIOUSVERSION` and `NEXTVERSION`: reading a value from another version
//! of the Versions axis of the target.
//!
//! The values are read as the line item reads them, so the months before the switchover of a
//! version show the actual version also when a function reads them.

use crate::error::EngineError;
use crate::shape::{Axis, Shape};
use crate::value::Column;

use crate::formula::{EvalCtx, TExpr};

use super::axis::{needs_dimension, position, read_shifted};
use super::mismatch;

/// The position of the Versions axis of `target`, or the problem that it has none.
fn versions_axis(target: &Shape) -> Result<usize, EngineError> {
    target
        .axis_pos(&Axis::Versions)
        .ok_or_else(|| needs_dimension("Versions"))
}

/// Checks that the line item has a Versions dimension.
pub(super) fn check(target: &Shape) -> Result<(), EngineError> {
    versions_axis(target).map(|_| ())
}

/// `CURRENTVERSION(x)`: `x` in the version flagged as current, which is blank when the line
/// item does not have that version.
pub(super) fn eval_current(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let axis = versions_axis(target)?;
    let keys = ctx
        .structure
        .axis_keys(&Axis::Versions, ctx.layout.restriction.as_deref())?;
    let current = ctx
        .structure
        .versions()
        .iter()
        .find(|version| version.is_current)
        .and_then(|version| {
            keys.iter()
                .position(|key| *key == Some(version.id.0.as_u128()))
        });
    let Some(current) = current else {
        let ty = args[0].ty().ok_or_else(mismatch)?;
        return Ok(Column::new_blank(&ty, idx.len()));
    };
    let steps: Vec<i64> = idx
        .iter()
        .map(|&cell| current as i64 - position(target, axis, cell) as i64)
        .collect();
    read_shifted(ctx, target, axis, (&args[0], None), &steps, idx)
}

/// `PREVIOUSVERSION(x)` for a `step` of -1 and `NEXTVERSION(x)` for a `step` of 1: `x` in the
/// version before or after the one being calculated, in the order of the Versions axis of the
/// line item; blank where there is none.
pub(super) fn eval_adjacent(
    step: i64,
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let axis = versions_axis(target)?;
    read_shifted(
        ctx,
        target,
        axis,
        (&args[0], None),
        &vec![step; idx.len()],
        idx,
    )
}
