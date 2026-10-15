//! Switchovers (spec §3.4): the months of a version before its switchover month show the
//! values of the actual version, in formulas and in the totals of a grid alike.

use crate::calendar::TimeLevel;
use crate::error::EngineError;
use crate::ids::{TimeRangeId, VersionId};
use crate::shape::{Axis, Shape};
use crate::structure::Structure;
use crate::value::Column;

/// For each version in `keys`, how many leading periods of a time axis lie entirely before the
/// version's switchover month; 0 for a version without one.
pub(crate) fn cutoffs(
    structure: &Structure,
    level: TimeLevel,
    range: Option<TimeRangeId>,
    keys: &[Option<u128>],
) -> Result<Vec<u32>, EngineError> {
    let calendar = structure.time_calendar(range)?;
    let offset = structure.time_offset(range);
    Ok(keys
        .iter()
        .map(|key| {
            let switchover = key
                .and_then(|key| structure.version(VersionId(uuid::Uuid::from_u128(key))))
                .and_then(|version| version.switchover);
            switchover.map_or(0, |month| {
                (0..calendar.periods(level))
                    .take_while(|&period| {
                        let end = calendar.months_in_period(level, period).end;
                        offset + i64::from(end) <= i64::from(month)
                    })
                    .count() as u32
            })
        })
        .collect())
}

/// The cells of a grid over `shape` as formulas and totals read them: in every version with a
/// switchover, the periods entirely before it hold the cells of the actual version. `None`
/// when no cell changes, which is the case for a grid without both Time and Versions axes and
/// for versions without a switchover. `restriction` names the versions of a restricted
/// Versions axis.
pub(crate) fn with_actual_before_switchover(
    structure: &Structure,
    shape: &Shape,
    restriction: Option<&[VersionId]>,
    cells: &Column,
) -> Result<Option<Column>, EngineError> {
    let (Some(time), Some(versions)) = (shape.time_pos(), shape.axis_pos(&Axis::Versions)) else {
        return Ok(None);
    };
    let Axis::Time { level, range } = shape.axes[time] else {
        return Ok(None);
    };
    let keys = structure.axis_keys(&Axis::Versions, restriction)?;
    let actual = structure
        .versions()
        .iter()
        .find(|version| version.is_actual)
        .and_then(|version| {
            keys.iter()
                .position(|key| *key == Some(version.id.0.as_u128()))
        });
    let cutoff = cutoffs(structure, level, range, &keys)?;
    let Some(actual) =
        actual.filter(|_| cutoff.iter().any(|&periods| periods > 0) && cells.len() == shape.size())
    else {
        return Ok(None);
    };
    let swap = Swap {
        version_stride: shape.strides[versions],
        version_len: shape.lens[versions] as usize,
        time_stride: shape.strides[time],
        time_len: shape.lens[time] as usize,
        actual,
        cutoff: &cutoff,
    };
    Ok(Some(match cells {
        Column::Number(cells) => Column::Number(swap.apply(cells)),
        Column::Boolean(cells) => Column::Boolean(swap.apply(cells)),
        Column::Text(cells) => Column::Text(swap.apply(cells)),
        Column::Date(cells) => Column::Date(swap.apply(cells)),
        Column::Item(cells) => Column::Item(swap.apply(cells)),
        Column::Period(cells) => Column::Period(swap.apply(cells)),
    }))
}

/// Where the cells before a switchover are copied from: the same cell of the actual version.
struct Swap<'a> {
    version_stride: usize,
    version_len: usize,
    time_stride: usize,
    time_len: usize,
    actual: usize,
    cutoff: &'a [u32],
}

impl Swap<'_> {
    fn apply<T: Clone>(&self, cells: &[T]) -> Vec<T> {
        let mut out = cells.to_vec();
        for (index, cell) in out.iter_mut().enumerate() {
            let version = index / self.version_stride % self.version_len;
            let period = index / self.time_stride % self.time_len;
            if period < self.cutoff[version] as usize {
                let from =
                    index - version * self.version_stride + self.actual * self.version_stride;
                *cell = cells[from].clone();
            }
        }
        out
    }
}
