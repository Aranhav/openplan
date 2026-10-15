//! Reading cells at any level of their dimensions, and writing the coordinates of a cell the way
//! the calendar does.

use crate::calendar::{Calendar, TimeLevel};
use crate::command::CoordToken;
use crate::error::EngineError;
use crate::ids::{ItemId, LineItemId, ListId};
use crate::shape::Axis;
use crate::structure::{Layout, level_name};
use crate::summary::{LevelSpec, ancestors};
use crate::value::Value;

use super::{Model, decode};

/// Where the actual version lies in the cells of a line item with both a Time and a Versions
/// axis: the position of the Versions axis among the axes, and the position of the version
/// along it.
struct ActualSlot {
    axis: usize,
    position: u32,
}

impl Model {
    /// Reads cells of a line item, each addressed by one token per axis, at the level the token
    /// names. A list or subset axis takes an item of its list, which reads the cell itself, an
    /// item of a list above it, which reads the total of the items below it, or `"top"`, which
    /// reads the total of all of them. A Time axis takes the label of a period at its level or
    /// a coarser one, whatever the case, and a Versions axis the id of a version. The totals
    /// are those of the line item's summary methods (see [`Model::read_summary`]).
    ///
    /// A cell of a version before its switchover reads as the same cell of the actual version,
    /// which is what formulas see; [`Model::read_cells`] reads the stored cell.
    ///
    /// A token that fits no level of its axis is an `InvalidCoordinate` error that says which
    /// cell it is in.
    pub fn read(
        &self,
        li: LineItemId,
        cells: &[Vec<CoordToken>],
    ) -> Result<Vec<Value>, EngineError> {
        let line_item = self
            .structure
            .line_item(li)
            .ok_or_else(|| EngineError::not_found("line item", li.0))?;
        let layout = self.structure.layout(line_item)?;
        let shape = self.structure.shape_of(&layout)?;
        let ty = line_item.format.value_type();
        let column = self.inputs.get(&li).or_else(|| self.computed.get(&li));
        let actual = self.actual_slot(&layout)?;
        cells
            .iter()
            .enumerate()
            .map(|(index, tokens)| {
                let at = |message: String| EngineError::InvalidCoordinate {
                    message: format!("Cell {index}: {message}"),
                };
                let levels = self.levels_of(&layout, tokens).map_err(at)?;
                if levels != layout.axes {
                    return self
                        .read_summary(li, tokens, &LevelSpec(levels))
                        .map_err(|error| match error {
                            EngineError::InvalidCoordinate { message } => at(message),
                            other => other,
                        });
                }
                let mut position = self.structure.resolve_cell(&layout, tokens).map_err(at)?;
                if let Some(actual) = &actual
                    && self.structure.is_before_switchover(&layout, &position)
                {
                    position[actual.axis] = actual.position;
                }
                Ok(column.map_or_else(
                    || ty.blank(),
                    |column| decode(&self.structure, &ty, column.get(shape.index(&position))),
                ))
            })
            .collect()
    }

    /// The coordinates of cells of a line item with every period label written as the calendar
    /// writes it: `Jan 26` for `jan  26`. A cell then always has the same coordinates, so that it
    /// has one history. Whatever is not a period label of its axis is returned as it is, for the
    /// command that uses the coordinates to reject.
    pub fn canonical_coords(
        &self,
        li: LineItemId,
        cells: &[Vec<CoordToken>],
    ) -> Result<Vec<Vec<CoordToken>>, EngineError> {
        let line_item = self
            .structure
            .line_item(li)
            .ok_or_else(|| EngineError::not_found("line item", li.0))?;
        let layout = self.structure.layout(line_item)?;
        let calendars = layout
            .axes
            .iter()
            .map(|axis| match axis {
                Axis::Time { level, range } => self
                    .structure
                    .time_calendar(*range)
                    .map(|calendar| Some((*level, calendar))),
                _ => Ok(None),
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(cells
            .iter()
            .map(|tokens| {
                tokens
                    .iter()
                    .enumerate()
                    .map(|(position, token)| {
                        let calendar = calendars.get(position).and_then(Option::as_ref);
                        match (token, calendar) {
                            (CoordToken::Period(label), Some((level, calendar))) => {
                                canonical_label(calendar, *level, label)
                                    .map_or_else(|| token.clone(), CoordToken::Period)
                            }
                            _ => token.clone(),
                        }
                    })
                    .collect()
            })
            .collect())
    }

    /// Where the actual version lies in the cells of `layout`, if they have a Time and a
    /// Versions axis and the actual version is on the latter.
    fn actual_slot(&self, layout: &Layout) -> Result<Option<ActualSlot>, EngineError> {
        let has_time = layout
            .axes
            .iter()
            .any(|axis| matches!(axis, Axis::Time { .. }));
        let Some(axis) = layout.axes.iter().position(|axis| *axis == Axis::Versions) else {
            return Ok(None);
        };
        if !has_time {
            return Ok(None);
        }
        let keys = self
            .structure
            .axis_keys(&Axis::Versions, layout.restriction.as_deref())?;
        Ok(self
            .structure
            .versions()
            .iter()
            .find(|version| version.is_actual)
            .and_then(|actual| {
                keys.iter()
                    .position(|key| *key == Some(actual.id.0.as_u128()))
            })
            .map(|position| ActualSlot {
                axis,
                position: position as u32,
            }))
    }

    /// The level each axis of `layout` is read at for the cell `tokens` address, or what is wrong
    /// with the tokens.
    fn levels_of(&self, layout: &Layout, tokens: &[CoordToken]) -> Result<Vec<Axis>, String> {
        if tokens.len() != layout.axes.len() {
            return Err(format!(
                "Expected {} coordinates but got {}.",
                layout.axes.len(),
                tokens.len()
            ));
        }
        layout
            .axes
            .iter()
            .zip(tokens)
            .map(|(axis, token)| self.level_of(axis, token))
            .collect()
    }

    fn level_of(&self, axis: &Axis, token: &CoordToken) -> Result<Axis, String> {
        match (axis, token) {
            (Axis::List(list), CoordToken::Item(item)) => {
                let own = self.structure.list(*list);
                if own.is_some_and(|own| own.idx(*item).is_some()) {
                    return Ok(axis.clone());
                }
                self.level_above(
                    *list,
                    *item,
                    format!("list '{}'", self.structure.list_name(*list)),
                )
            }
            (Axis::Subset(id), CoordToken::Item(item)) => {
                let subset = self
                    .structure
                    .subset(*id)
                    .ok_or_else(|| format!("Subset {} does not exist.", id.0))?;
                if subset.items.contains(item) {
                    return Ok(axis.clone());
                }
                self.level_above(subset.list, *item, format!("subset '{}'", subset.name))
            }
            (Axis::List(list), CoordToken::Period(label)) if is_top(label) => {
                Ok(Axis::ListTop(*list))
            }
            (Axis::Subset(id), CoordToken::Period(label)) if is_top(label) => self
                .structure
                .subset(*id)
                .map(|subset| Axis::ListTop(subset.list))
                .ok_or_else(|| format!("Subset {} does not exist.", id.0)),
            (Axis::Time { level, range }, CoordToken::Period(label)) => {
                let calendar = self
                    .structure
                    .time_calendar(*range)
                    .map_err(|error| error.to_string())?;
                match calendar.parse_label(label) {
                    Some((found, _)) if found >= *level => Ok(Axis::Time {
                        level: found,
                        range: *range,
                    }),
                    _ => Err(format!(
                        "'{label}' is not a {} period or a coarser one of this time axis.",
                        level_name(*level)
                    )),
                }
            }
            (Axis::Versions, CoordToken::Item(_)) => Ok(Axis::Versions),
            (axis, _) => Err(format!("Expected {} here.", describe(axis))),
        }
    }

    /// The level of a list above `list` that holds `item`, for a cell whose axis is `what`.
    fn level_above(&self, list: ListId, item: ItemId, what: String) -> Result<Axis, String> {
        let above = ancestors(&self.structure, list).map_err(|error| error.to_string())?;
        above
            .into_iter()
            .skip(1)
            .find(|candidate| {
                self.structure
                    .list(*candidate)
                    .is_some_and(|candidate| candidate.idx(item).is_some())
            })
            .map(Axis::List)
            .ok_or_else(|| format!("{} is not an item of {what} or of a list above it.", item.0))
    }
}

/// Whether a token stands for the total of a list.
fn is_top(label: &str) -> bool {
    label.trim().eq_ignore_ascii_case("top")
}

fn describe(axis: &Axis) -> &'static str {
    match axis {
        Axis::List(_) | Axis::Subset(_) => "an item id or \"top\"",
        Axis::ListTop(_) => "the token \"top\"",
        Axis::Time { .. } => "a period label",
        Axis::Versions => "a version id",
    }
}

/// The label the calendar gives the period that `label` names, if that period is at `level`.
fn canonical_label(calendar: &Calendar, level: TimeLevel, label: &str) -> Option<String> {
    let (found, period) = calendar.parse_label(label)?;
    (found == level).then(|| calendar.label(found, period))
}
