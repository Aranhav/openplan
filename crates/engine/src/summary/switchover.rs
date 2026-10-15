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
    let Some(swap) = Swap::of(structure, shape, restriction)? else {
        return Ok(None);
    };
    if cells.len() != shape.size() {
        return Ok(None);
    }
    Ok(Some(match cells {
        Column::Number(cells) => Column::Number(swap.apply(cells)),
        Column::Boolean(cells) => Column::Boolean(swap.apply(cells)),
        Column::Text(cells) => Column::Text(swap.apply(cells)),
        Column::Date(cells) => Column::Date(swap.apply(cells)),
        Column::Item(cells) => Column::Item(swap.apply(cells)),
        Column::Period(cells) => Column::Period(swap.apply(cells)),
    }))
}

/// Brings `shown`, the cells of a grid over `shape` as formulas and totals read them (see
/// [`with_actual_before_switchover`]), in line with the cells `at` of `cells` after they were
/// written: a cell of the actual version shows in the versions that read it before their
/// switchover, and a cell that a version does not show stays as it was.
pub(crate) fn show_written(
    structure: &Structure,
    shape: &Shape,
    restriction: Option<&[VersionId]>,
    (cells, at): (&Column, &[usize]),
    shown: &mut Column,
) -> Result<(), EngineError> {
    if let Some(swap) = Swap::of(structure, shape, restriction)? {
        swap.update(shown, cells, at);
    }
    Ok(())
}

/// Where the cells before a switchover are copied from: the same cell of the actual version.
struct Swap {
    version_stride: usize,
    version_len: usize,
    time_stride: usize,
    time_len: usize,
    actual: usize,
    cutoff: Vec<u32>,
}

impl Swap {
    /// How a grid over `shape` shows the actual version, if any of its cells change.
    fn of(
        structure: &Structure,
        shape: &Shape,
        restriction: Option<&[VersionId]>,
    ) -> Result<Option<Swap>, EngineError> {
        let (Some(time), Some(versions)) = (shape.time_pos(), shape.axis_pos(&Axis::Versions))
        else {
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
        let Some(actual) = actual.filter(|_| cutoff.iter().any(|&periods| periods > 0)) else {
            return Ok(None);
        };
        Ok(Some(Swap {
            version_stride: shape.strides[versions],
            version_len: shape.lens[versions] as usize,
            time_stride: shape.strides[time],
            time_len: shape.lens[time] as usize,
            actual,
            cutoff,
        }))
    }

    /// Updates the cells `at` of `shown` from `cells`.
    fn update(&self, shown: &mut Column, cells: &Column, at: &[usize]) {
        for &index in at {
            let version = index / self.version_stride % self.version_len;
            let period = index / self.time_stride % self.time_len;
            let cell = cells.get(index);
            if period >= self.cutoff[version] as usize {
                shown.set(index, cell.clone());
            }
            if version == self.actual {
                for (other, &periods) in self.cutoff.iter().enumerate() {
                    if period < periods as usize {
                        let there =
                            index - version * self.version_stride + other * self.version_stride;
                        shown.set(there, cell.clone());
                    }
                }
            }
        }
    }

    fn apply<T: Clone>(&self, cells: &[T]) -> Vec<T> {
        let mut out = cells.to_vec();
        let (time_len, version_len) = (self.time_len, self.version_len);
        // Time followed by Versions is how cells are laid out, so the periods to swap are then
        // found by counting and not by looking at every cell.
        if self.version_stride == 1 && self.time_stride == version_len {
            let block = time_len * version_len;
            for outer in 0..cells.len().checked_div(block).unwrap_or(0) {
                for (version, &periods) in self.cutoff.iter().enumerate() {
                    for period in 0..(periods as usize).min(time_len) {
                        let index = outer * block + period * version_len + version;
                        out[index] = cells[index - version + self.actual].clone();
                    }
                }
            }
            return out;
        }
        for (index, cell) in out.iter_mut().enumerate() {
            let version = index / self.version_stride % version_len;
            let period = index / self.time_stride % time_len;
            if period < self.cutoff[version] as usize {
                let from =
                    index - version * self.version_stride + self.actual * self.version_stride;
                *cell = cells[from].clone();
            }
        }
        out
    }
}
