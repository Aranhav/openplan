//! `RANK`: the place of a value among the values of the same Time period and version.

use rayon::prelude::*;

use crate::error::EngineError;
use crate::shape::{Axis, Shape};
use crate::value::Column;

use crate::formula::{EvalCtx, TExpr};

use super::axis::needs_dimension;
use super::{Word, shared, whole_numbers};

/// Whether the cells along `axis` are items of a list.
fn is_list(axis: &Axis) -> bool {
    matches!(axis, Axis::List(_) | Axis::Subset(_) | Axis::ListTop(_))
}

/// Checks that the line item has a list to rank across.
pub(super) fn check(target: &Shape) -> Result<(), EngineError> {
    if target.axes.iter().any(is_list) {
        Ok(())
    } else {
        Err(needs_dimension("list"))
    }
}

/// `RANK(x)` and `RANK(x, order)`: the place of the value among the values of all items of
/// the list dimensions, taken together, at the same period and version. With the order
/// `DESCENDING`, which is the default, 1 is the highest value; with `ASCENDING` it is the
/// lowest. Equal values have the lowest place of them: 1, 2, 2, 4. Items that were deleted take
/// no part and have no place.
pub(super) fn eval_rank(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    shared(ctx, target, args, idx, || {
        let values = whole_numbers(ctx, target, &args[0])?;
        let descending = !matches!(
            args.get(1),
            Some(TExpr::Word {
                word: Word::Ascending,
                ..
            })
        );
        Ok(Column::Number(rank_all(ctx, target, &values, descending)))
    })
}

fn rank_all(ctx: &EvalCtx, target: &Shape, values: &[f64], descending: bool) -> Vec<f64> {
    let (ranked, sliced): (Vec<usize>, Vec<usize>) =
        (0..target.axes.len()).partition(|&axis| is_list(&target.axes[axis]));
    // A slice is a period of one version; its members are the cells of the items across the
    // lists, which are at the same offsets from the first cell of every slice.
    let members = offsets(target, &ranked, |axis, position| {
        live(ctx, target, axis, position)
    });
    let slices = offsets(target, &sliced, |_, _| true);
    let ranks: Vec<Vec<f64>> = slices
        .par_iter()
        .map(|&slice| rank_slice(values, slice, &members, descending))
        .collect();
    let mut out = vec![0.0; values.len()];
    for (&slice, ranks) in slices.iter().zip(&ranks) {
        for (&member, &rank) in members.iter().zip(ranks) {
            out[slice + member] = rank;
        }
    }
    out
}

/// The offset from the first cell, in cells, of every combination of the live positions on
/// `axes`.
fn offsets(target: &Shape, axes: &[usize], keep: impl Fn(usize, u32) -> bool) -> Vec<usize> {
    let mut offsets = vec![0];
    for &axis in axes {
        let stride = target.strides[axis];
        offsets = offsets
            .iter()
            .flat_map(|&base| {
                let keep = &keep;
                (0..target.lens[axis])
                    .filter(move |&position| keep(axis, position))
                    .map(move |position| base + position as usize * stride)
            })
            .collect();
    }
    offsets
}

/// Whether the item at `position` of the list axis `axis` of `target` is there, that is not
/// deleted.
fn live(ctx: &EvalCtx, target: &Shape, axis: usize, position: u32) -> bool {
    match &target.axes[axis] {
        Axis::List(list) => ctx
            .structure
            .list(*list)
            .is_none_or(|list| !list.item(position).deleted),
        _ => true,
    }
}

/// The places of the members of the slice at `slice`, in the order of `members`.
fn rank_slice(values: &[f64], slice: usize, members: &[usize], descending: bool) -> Vec<f64> {
    let mut order: Vec<(f64, usize)> = members
        .iter()
        .enumerate()
        .map(|(member, &offset)| (values[slice + offset], member))
        .collect();
    if descending {
        order.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));
    } else {
        order.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    }
    let mut ranks = vec![0.0; members.len()];
    let mut place = 1;
    for (at, &(value, member)) in order.iter().enumerate() {
        if at > 0 && value != order[at - 1].0 {
            place = at + 1;
        }
        ranks[member] = place as f64;
    }
    ranks
}
