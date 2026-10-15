//! Aligning the Time and Versions axes of a source with those of the target.

use std::sync::Arc;

use crate::calendar::TimeLevel;
use crate::error::EngineError;
use crate::formula::SelectTarget;
use crate::ids::TimeRangeId;
use crate::shape::Axis;
use crate::summary::cutoffs;
use crate::value::ValueType;

use super::{AxisPlan, Builder, Driver, Feed, Work, dimension, mismatched_modifier};

impl Builder<'_> {
    pub(super) fn plan_time(
        &self,
        source: (TimeLevel, Option<TimeRangeId>),
        driver: &Driver,
        matched: Option<usize>,
    ) -> Result<AxisPlan, EngineError> {
        let structure = self.ctx.structure;
        let (wanted, periods, feed) = match (driver, matched) {
            (Driver::Select(SelectTarget::Period { level, index }), _) => {
                ((*level, None), vec![*index], Feed::Single)
            }
            (Driver::Lookup(reader, ValueType::Period(level)), _) => (
                (*level, None),
                (0..structure.calendar.periods(*level)).collect(),
                Feed::Values(Arc::clone(reader)),
            ),
            (Driver::Unassigned, Some(target)) => {
                let Axis::Time { level, range } = self.target.axes[target] else {
                    return Err(mismatched_modifier());
                };
                (
                    (level, range),
                    (0..self.target.lens[target]).collect(),
                    Feed::Axis(target),
                )
            }
            (Driver::Unassigned, None) => {
                return Ok(AxisPlan {
                    to: Axis::Time {
                        level: TimeLevel::All,
                        range: source.1,
                    },
                    positions: vec![Some(0)],
                    feed: Feed::Single,
                });
            }
            _ => return Err(mismatched_modifier()),
        };
        let (to, positions) = self.place_time(source, wanted, &periods)?;
        Ok(AxisPlan {
            to,
            positions,
            feed,
        })
    }

    /// Where the periods `periods` of the time axis `driver` land on a source time axis: the
    /// source period that contains the first month of each, once the source is rolled up to the
    /// driver's level if it is finer. Periods are matched by calendar month, so axes with
    /// different time ranges line up by date.
    fn place_time(
        &self,
        source: (TimeLevel, Option<TimeRangeId>),
        driver: (TimeLevel, Option<TimeRangeId>),
        periods: &[u32],
    ) -> Result<(Axis, Vec<Option<u32>>), EngineError> {
        let structure = self.ctx.structure;
        let ((level, range), (driver_level, driver_range)) = (source, driver);
        let to_level = level.max(driver_level);
        let source_calendar = structure.time_calendar(range)?;
        let driver_calendar = structure.time_calendar(driver_range)?;
        let source_offset = structure.time_offset(range);
        let driver_offset = structure.time_offset(driver_range);
        let positions = periods
            .iter()
            .map(|&period| {
                let first = driver_calendar.months_in_period(driver_level, period).start;
                let month = driver_offset + i64::from(first) - source_offset;
                u32::try_from(month)
                    .ok()
                    .filter(|&month| month < source_calendar.months())
                    .map(|month| source_calendar.period_of_month(month, to_level))
            })
            .collect();
        Ok((
            Axis::Time {
                level: to_level,
                range,
            },
            positions,
        ))
    }

    /// Plans the Versions axis of the source. Reading the same version as the target's cell, the
    /// periods before its switchover read the actual version. The source cells already show
    /// that for a source with a time axis at least as fine as the target's (`Work` holds them
    /// that way); for any other source it is the target's own periods that decide.
    pub(super) fn plan_versions(
        &self,
        work: &Work,
        drivers: &[Driver],
        driver: &Driver,
        matched: Option<usize>,
    ) -> Result<AxisPlan, EngineError> {
        let structure = self.ctx.structure;
        let source_keys = structure.axis_keys(&Axis::Versions, work.restriction.as_deref())?;
        let position_of = |key: Option<u128>| {
            key.and_then(|key| source_keys.iter().position(|source| *source == Some(key)))
                .map(|position| position as u32)
        };
        match (driver, matched) {
            (Driver::Select(SelectTarget::Version(version)), _) => Ok(AxisPlan {
                to: Axis::Versions,
                positions: vec![position_of(Some(version.0.as_u128()))],
                feed: Feed::Single,
            }),
            (Driver::Unassigned, Some(target)) => {
                let target_keys = structure.axis_keys(&Axis::Versions, self.restriction)?;
                let time = self.cutoff_time(work, drivers);
                let cutoff = match time {
                    Some(time) => {
                        let Axis::Time { level, range } = self.target.axes[time] else {
                            return Err(mismatched_modifier());
                        };
                        cutoffs(structure, level, range, &target_keys)?
                    }
                    None => vec![0; target_keys.len()],
                };
                let actual = structure
                    .versions()
                    .iter()
                    .find(|version| version.is_actual)
                    .and_then(|version| position_of(Some(version.id.0.as_u128())));
                Ok(AxisPlan {
                    to: Axis::Versions,
                    positions: target_keys.iter().map(|key| position_of(*key)).collect(),
                    feed: Feed::Versions {
                        axis: target,
                        time,
                        actual,
                        cutoff,
                    },
                })
            }
            (Driver::Unassigned, None) => Err(dimension("Use SELECT to choose a version.")),
            _ => Err(mismatched_modifier()),
        }
    }

    /// The target's time axis, when the target's own periods decide which cells read the actual
    /// version: the source has no time axis, or one that is coarser than the target's and
    /// follows it.
    fn cutoff_time(&self, work: &Work, drivers: &[Driver]) -> Option<usize> {
        let time = self.target.time_pos()?;
        let Axis::Time { level: wanted, .. } = self.target.axes[time] else {
            return None;
        };
        let source = work
            .shape
            .axes
            .iter()
            .zip(drivers)
            .find_map(|(axis, driver)| match axis {
                Axis::Time { level, .. } => Some((*level, matches!(driver, Driver::Unassigned))),
                _ => None,
            });
        match source {
            None => Some(time),
            Some((level, follows_target)) => (follows_target && level > wanted).then_some(time),
        }
    }
}
