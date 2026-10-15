//! The functions that move or scan along the Time axis of the target: `PREVIOUS`, `NEXT`,
//! `OFFSET`, `LAG`, `LEAD`, `CUMULATE`, `MOVINGSUM`, `TIMESUM`, the to-date functions and the
//! functions that read the summary of the containing period.
//!
//! The Time axis is that of the line item the formula is for: of its module, its time range or
//! its own time scale. Positions along it count periods of that axis, whatever its level.

use std::ops::Range;

use crate::calendar::TimeLevel;
use crate::error::EngineError;
use crate::shape::{Axis, Shape};
use crate::structure::level_name;
use crate::value::{Column, ValueType, sanitize_number};

use crate::formula::align::take;
use crate::formula::eval::{eval, eval_whole};
use crate::formula::{EvalCtx, TExpr};

use super::axis::{Lines, count_steps, dimension_problem, needs_dimension, position, read_shifted};
use super::period::span;
use super::rules::join_choice;
use super::{FuncId, call_key, mismatch, shared, whole_numbers};

/// The position of the Time axis of `target`, or the problem that it has none.
pub(super) fn time_axis(target: &Shape) -> Result<usize, EngineError> {
    target.time_pos().ok_or_else(|| needs_dimension("Time"))
}

/// The level the to-date and the value functions work at: the period they sum up to or read
/// the summary of.
fn level_of(func: FuncId) -> Option<TimeLevel> {
    match func {
        FuncId::YearValue | FuncId::YearToDate => Some(TimeLevel::Year),
        FuncId::HalfYearValue | FuncId::HalfYearToDate => Some(TimeLevel::HalfYear),
        FuncId::QuarterValue | FuncId::QuarterToDate => Some(TimeLevel::Quarter),
        FuncId::MonthValue => Some(TimeLevel::Month),
        _ => None,
    }
}

/// Checks that the line item has a Time dimension, and for the functions that work at a level
/// that its time scale is that level or a finer one: a year has no quarter to read the
/// summary of.
pub(super) fn check(func: FuncId, target: &Shape) -> Result<(), EngineError> {
    let axis = time_axis(target)?;
    let (Some(wanted), Axis::Time { level: found, .. }) = (level_of(func), &target.axes[axis])
    else {
        return Ok(());
    };
    if *found <= wanted {
        return Ok(());
    }
    let levels: Vec<&str> = [
        TimeLevel::Month,
        TimeLevel::Quarter,
        TimeLevel::HalfYear,
        TimeLevel::Year,
    ]
    .into_iter()
    .filter(|level| *level <= wanted)
    .map(level_name)
    .collect();
    Err(dimension_problem(format!(
        "{} needs a line item by {}, but this one is by {}.",
        func.def().name,
        join_choice(&levels),
        level_name(*found)
    )))
}

/// The target with its Time axis at `level`, which is the shape the argument of `YEARVALUE` and
/// its kin is evaluated over; `None` when the target has no Time axis or its axis is coarser.
fn at_level(ctx: &EvalCtx, target: &Shape, level: TimeLevel) -> Option<Shape> {
    let axis = target.time_pos()?;
    let Axis::Time {
        level: found,
        range,
    } = target.axes[axis]
    else {
        return None;
    };
    if found > level {
        return None;
    }
    let mut axes = target.axes.clone();
    axes[axis] = Axis::Time { level, range };
    let mut lens = target.lens.clone();
    lens[axis] = ctx.structure.time_calendar(range).ok()?.periods(level);
    Some(Shape::new(axes, lens))
}

/// The shape the argument of a call to `func` is evaluated over when it is not the target's
/// own: the target at the level of `YEARVALUE`, `QUARTERVALUE`, `HALFYEARVALUE` or
/// `MONTHVALUE`.
pub(super) fn arg_target(func: FuncId, ctx: &EvalCtx, target: &Shape) -> Option<Shape> {
    match func {
        FuncId::YearValue | FuncId::QuarterValue | FuncId::HalfYearValue | FuncId::MonthValue => {
            at_level(ctx, target, level_of(func)?)
        }
        _ => None,
    }
}

/// For each period of the Time axis of `target` at `axis`, the period at `level` that contains
/// it. The level is that of the axis or a coarser one.
fn containing(
    ctx: &EvalCtx,
    target: &Shape,
    axis: usize,
    level: TimeLevel,
) -> Result<Vec<u32>, EngineError> {
    let Axis::Time { level: own, range } = target.axes[axis] else {
        return Err(mismatch());
    };
    let calendar = ctx.structure.time_calendar(range)?;
    Ok((0..target.lens[axis])
        .map(|period| calendar.period_of_month(calendar.months_in_period(own, period).start, level))
        .collect())
}

/// `PREVIOUS(x)`: the value one period before, blank at the start of the timeline.
pub(super) fn eval_previous(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    read_along_time(ctx, target, (&args[0], None), vec![-1; idx.len()], idx)
}

/// `NEXT(x)`: the value one period after, blank at the end of the timeline.
pub(super) fn eval_next(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    read_along_time(ctx, target, (&args[0], None), vec![1; idx.len()], idx)
}

/// `OFFSET(x, n, default)` and `LEAD(x, n, default)` for a positive `direction`, which read
/// `n` periods after, and `LAG(x, n, default)` for a negative one, which reads `n` periods
/// before. Beyond the timeline they give the default.
pub(super) fn eval_shift(
    direction: i64,
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let [x, count, default] = args else {
        return Err(mismatch());
    };
    let counts = eval(ctx, target, count, idx)?;
    let steps = count_steps(&counts, direction)?;
    read_along_time(ctx, target, (x, Some(default)), steps, idx)
}

fn read_along_time(
    ctx: &EvalCtx,
    target: &Shape,
    source: (&TExpr, Option<&TExpr>),
    steps: Vec<i64>,
    idx: &[usize],
) -> Result<Column, EngineError> {
    read_shifted(ctx, target, time_axis(target)?, source, &steps, idx)
}

/// `CUMULATE(x)`: the total of the values from the first period to this one. A total that
/// overflows is 0 at once, like any other sum, and the next period starts from it.
pub(super) fn eval_cumulate(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    shared(ctx, target, args, idx, || {
        let lines = Lines::new(target, time_axis(target)?);
        let mut cells = whole_numbers(ctx, target, &args[0])?;
        for origin in lines.origins() {
            let mut total = 0.0;
            for at in 0..lines.len {
                let cell = lines.cell(origin, at);
                total = sanitize_number(total + cells[cell]);
                cells[cell] = total;
            }
        }
        Ok(Column::Number(cells))
    })
}

/// `YEARTODATE(x)` and its kin: the total of the values from the first period of the year,
/// half-year or quarter that holds this one up to this one.
pub(super) fn eval_to_date(
    level: TimeLevel,
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    shared(ctx, target, args, idx, || {
        let axis = time_axis(target)?;
        let lines = Lines::new(target, axis);
        let holders = containing(ctx, target, axis, level)?;
        let mut cells = whole_numbers(ctx, target, &args[0])?;
        for origin in lines.origins() {
            let mut total = 0.0;
            let mut holder = None;
            for (at, &next) in holders.iter().enumerate() {
                if holder != Some(next) {
                    holder = Some(next);
                    total = 0.0;
                }
                let cell = lines.cell(origin, at);
                total = sanitize_number(total + cells[cell]);
                cells[cell] = total;
            }
        }
        Ok(Column::Number(cells))
    })
}

/// `MOVINGSUM(x, from, to)`: the total of the values from `from` periods away to `to` periods
/// away, which are before this period when negative, clipped to the timeline. It is 0 when the
/// window ends before it starts.
pub(super) fn eval_moving_sum(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let [x, from, to] = args else {
        return Err(mismatch());
    };
    shared(ctx, target, args, idx, || {
        let lines = Lines::new(target, time_axis(target)?);
        let (x, from, to) = (
            whole_numbers(ctx, target, x)?,
            whole_numbers(ctx, target, from)?,
            whole_numbers(ctx, target, to)?,
        );
        let last = lines.len as i64 - 1;
        let mut out = vec![0.0; x.len()];
        for origin in lines.origins() {
            for at in 0..lines.len {
                let cell = lines.cell(origin, at);
                let first = (at as i64).saturating_add(from[cell] as i64).max(0);
                let end = (at as i64).saturating_add(to[cell] as i64).min(last);
                let total: f64 = (first..=end)
                    .map(|source| x[lines.cell(origin, source as usize)])
                    .sum();
                out[cell] = sanitize_number(total);
            }
        }
        Ok(Column::Number(out))
    })
}

/// `TIMESUM(x)` and `TIMESUM(x, from, to)`: the total of the values over all periods, or over
/// the periods that lie inside the time from the start of the period `from` to the end of the
/// period `to`. Both are periods of the model calendar, of any level, and a period that is
/// not set leaves nothing to add up.
pub(super) fn eval_time_sum(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    shared(ctx, target, args, idx, || match args {
        [x] => sum_all(ctx, target, x),
        [x, from, to] => sum_between(ctx, target, x, (from, to)),
        _ => Err(mismatch()),
    })
}

fn sum_all(ctx: &EvalCtx, target: &Shape, x: &TExpr) -> Result<Column, EngineError> {
    let lines = Lines::new(target, time_axis(target)?);
    let x = whole_numbers(ctx, target, x)?;
    let mut out = vec![0.0; x.len()];
    for origin in lines.origins() {
        let total = sanitize_number((0..lines.len).map(|at| x[lines.cell(origin, at)]).sum());
        for at in 0..lines.len {
            out[lines.cell(origin, at)] = total;
        }
    }
    Ok(Column::Number(out))
}

fn sum_between(
    ctx: &EvalCtx,
    target: &Shape,
    x: &TExpr,
    (from, to): (&TExpr, &TExpr),
) -> Result<Column, EngineError> {
    let axis = time_axis(target)?;
    let lines = Lines::new(target, axis);
    let x = whole_numbers(ctx, target, x)?;
    let months = axis_months(ctx, target, axis)?;
    let (from, to) = (periods(ctx, target, from)?, periods(ctx, target, to)?);
    let mut out = vec![0.0; x.len()];
    for origin in lines.origins() {
        // The window is the same for most cells of a line, and so is the total.
        let mut last: Option<((i64, i64), f64)> = None;
        for at in 0..lines.len {
            let cell = lines.cell(origin, at);
            let window = from[cell]
                .as_ref()
                .zip(to[cell].as_ref())
                .map(|(from, to)| (from.start, to.end));
            out[cell] = match (window, last) {
                (None, _) => 0.0,
                (Some(window), Some((cached, total))) if window == cached => total,
                (Some(window), _) => {
                    // The periods inside the window are consecutive.
                    let first = months.partition_point(|period| period.start < window.0);
                    let end = months.partition_point(|period| period.end <= window.1);
                    let total = sanitize_number(
                        (first..end)
                            .map(|source| x[lines.cell(origin, source)])
                            .sum(),
                    );
                    last = Some((window, total));
                    total
                }
            };
        }
    }
    Ok(Column::Number(out))
}

/// The months of the model calendar that each period of the Time axis of `target` covers. A
/// time range starts at its own first month, which may lie outside the model calendar.
fn axis_months(ctx: &EvalCtx, target: &Shape, axis: usize) -> Result<Vec<Range<i64>>, EngineError> {
    let Axis::Time { level, range } = target.axes[axis] else {
        return Err(mismatch());
    };
    let calendar = ctx.structure.time_calendar(range)?;
    let offset = ctx.structure.time_offset(range);
    Ok((0..target.lens[axis])
        .map(|period| {
            let months = calendar.months_in_period(level, period);
            offset + i64::from(months.start)..offset + i64::from(months.end)
        })
        .collect())
}

/// For every cell of `target`, the months of the model calendar of the period `expr` gives
/// there, or `None` for one that is not set.
fn periods(
    ctx: &EvalCtx,
    target: &Shape,
    expr: &TExpr,
) -> Result<Vec<Option<Range<i64>>>, EngineError> {
    let (Some(ValueType::Period(level)), Column::Period(cells)) =
        (expr.ty(), eval_whole(ctx, target, expr)?)
    else {
        return Err(mismatch());
    };
    Ok(cells
        .iter()
        .map(|&period| {
            span(&ctx.structure.calendar, level, period)
                .map(|months| i64::from(months.start)..i64::from(months.end))
        })
        .collect())
}

/// `YEARVALUE(x)`, `HALFYEARVALUE(x)`, `QUARTERVALUE(x)` and `MONTHVALUE(x)`: `x` as it is at
/// the year, half-year, quarter or month that holds the period, which is what `x` is when the
/// line item is by that level. A line item that `x` reads is summarised to that level by its
/// own time summary method.
pub(super) fn eval_value(
    level: TimeLevel,
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let Some(view) = at_level(ctx, target, level) else {
        return Err(mismatch());
    };
    if view == *target {
        return eval(ctx, target, &args[0], idx);
    }
    let axis = time_axis(target)?;
    let holders = containing(ctx, target, axis, level)?;
    let whole = ctx.memoized(call_key(args), &view, || eval_whole(ctx, &view, &args[0]))?;
    // The view differs from the target in the length of its Time axis only.
    let (stride, len, view_len) = (
        target.strides[axis],
        target.lens[axis] as usize,
        view.lens[axis] as usize,
    );
    let cells: Vec<usize> = idx
        .iter()
        .map(|&cell| {
            let (outer, inner) = (cell / (stride * len), cell % stride);
            let holder = holders[position(target, axis, cell)] as usize;
            outer * stride * view_len + holder * stride + inner
        })
        .collect();
    Ok(take(&whole, &cells))
}
