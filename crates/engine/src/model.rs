use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::{Arc, Mutex, PoisonError};

use chrono::{Datelike, NaiveDate};

use crate::calendar::Calendar;
use crate::command::{CellEdit, ChangeSet, Command, CoordToken};
use crate::error::{CellIssue, EngineError, FormulaError};
use crate::formula::{ColumnSource, evaluate_formula};
use crate::ids::{LineItemId, ListId, VersionId};
use crate::shape::{Axis, Shape};
use crate::structure::{Layout, LineItem, Structure, level_name};
use crate::summary::{LevelSpec, Summary, SummaryCache, aggregate, ratio_parts};
use crate::value::{BLANK_DATE, BLANK_ITEM, BLANK_PERIOD, Cell, Column, Format, Value, ValueType};

/// Days from 0001-01-01 (day 1 of the common era) to 1970-01-01.
pub(crate) const EPOCH_DAYS_FROM_CE: i32 = 719_163;

const SWITCHOVER_MESSAGE: &str = "Periods before the switchover show Actual values.";

/// A planning model: its structure, the values typed into input line items and the values
/// calculated for the others.
#[derive(Clone, Debug)]
pub struct Model {
    structure: Arc<Structure>,
    inputs: HashMap<LineItemId, Arc<Column>>,
    /// The values of calculated line items as of the last recalculation.
    computed: HashMap<LineItemId, Arc<Column>>,
    /// What is wrong with the formulas of the calculated line items that have no values.
    errors: HashMap<LineItemId, Vec<FormulaError>>,
    generation: u64,
    summaries: SummaryCache,
}

impl Model {
    /// An empty model over `calendar`, with the default versions.
    ///
    /// The calendar is assumed valid; `Command::SetCalendar` validates one.
    pub fn new(calendar: Calendar) -> Model {
        Model {
            structure: Arc::new(Structure::new(calendar)),
            inputs: HashMap::new(),
            computed: HashMap::new(),
            errors: HashMap::new(),
            generation: 0,
            summaries: SummaryCache::default(),
        }
    }

    pub fn structure(&self) -> &Structure {
        &self.structure
    }

    /// Counts the applied commands and batches.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Applies one command. A rejected command leaves the model unchanged.
    pub fn apply(&mut self, cmd: Command) -> Result<ChangeSet, EngineError> {
        let mut changes = self.empty_change_set();
        self.apply_command(cmd, &mut changes)?;
        self.generation += 1;
        changes.generation = self.generation;
        self.summaries.record(&self.structure, &changes);
        Ok(changes)
    }

    /// Applies the commands in order as one change, all or nothing.
    pub fn apply_batch(&mut self, cmds: Vec<Command>) -> Result<ChangeSet, EngineError> {
        let mut changes = self.empty_change_set();
        if cmds.is_empty() {
            return Ok(changes);
        }
        let mut work = self.clone();
        for cmd in cmds {
            work.apply_command(cmd, &mut changes)?;
        }
        work.generation += 1;
        changes.generation = work.generation;
        work.summaries.record(&work.structure, &changes);
        *self = work;
        Ok(changes)
    }

    /// Calculates every line item that has a formula, each from the values of the line items
    /// computed before it in the order they were created, and returns the line items it
    /// computed.
    ///
    /// A line item whose formula does not resolve, or cannot be aligned with the line items it
    /// reads, gets blank values and the problems in [`Model::line_item_errors`].
    pub fn recalc_all(&mut self) -> Result<ChangeSet, EngineError> {
        let structure = Arc::clone(&self.structure);
        let mut working = Working {
            structure: &structure,
            inputs: &self.inputs,
            computed: HashMap::new(),
            rolled_up: Mutex::default(),
        };
        let mut errors = HashMap::new();
        let mut changes = self.empty_change_set();
        for line_item in structure.line_items().filter(|li| li.formula.is_some()) {
            let layout = structure.layout(line_item)?;
            let shape = structure.shape_of(&layout)?;
            let column = evaluate_formula(&structure, &working, line_item, &layout, &shape)
                .unwrap_or_else(|problems| {
                    errors.insert(line_item.id, problems);
                    Column::new_blank(&line_item.format.value_type(), shape.size())
                });
            working.insert(line_item.id, column);
            changes.note(line_item.id);
        }
        let Working { computed, .. } = working;
        self.computed = computed;
        self.errors = errors;
        self.generation += 1;
        changes.generation = self.generation;
        self.summaries.record(&self.structure, &changes);
        Ok(changes)
    }

    /// What is wrong with the formula of a calculated line item that has no values because of
    /// it, as of the last recalculation.
    pub fn line_item_errors(&self, li: LineItemId) -> Option<&[FormulaError]> {
        self.errors.get(&li).map(Vec::as_slice)
    }

    /// Reads leaf cells of a line item, each addressed by one token per axis.
    ///
    /// A calculated line item reads as blank until [`Model::recalc_all`] has computed it, and
    /// shows the values of the last recalculation, not of the edits made since.
    pub fn read_cells(
        &self,
        li: LineItemId,
        coords: &[Vec<CoordToken>],
    ) -> Result<Vec<Value>, EngineError> {
        let line_item = self
            .structure
            .line_item(li)
            .ok_or_else(|| missing_line_item(li))?;
        let layout = self.structure.layout(line_item)?;
        let shape = self.structure.shape_of(&layout)?;
        let ty = line_item.format.value_type();
        let column = self.inputs.get(&li).or_else(|| self.computed.get(&li));
        coords
            .iter()
            .enumerate()
            .map(|(index, tokens)| {
                let position = self
                    .structure
                    .resolve_cell(&layout, tokens)
                    .map_err(|message| EngineError::InvalidCoordinate {
                        message: format!("Cell {index}: {message}"),
                    })?;
                Ok(match column {
                    Some(column) => {
                        decode(&self.structure, &ty, column.get(shape.index(&position)))
                    }
                    None => blank_value(&ty),
                })
            })
            .collect()
    }

    /// Reads one cell of a line item rolled up to `levels`, addressed by one token per axis of
    /// `levels`. A list axis rolled up to an ancestor list takes an item of that list, one
    /// rolled up to its top level the token `"top"`, and a Time axis a period label at its
    /// level.
    ///
    /// The rolled-up cells are cached until the line item, or anything the roll-up depends
    /// on, changes.
    pub fn read_summary(
        &self,
        li: LineItemId,
        coords: &[CoordToken],
        levels: &LevelSpec,
    ) -> Result<Value, EngineError> {
        let line_item = self
            .structure
            .line_item(li)
            .ok_or_else(|| missing_line_item(li))?;
        let layout = self.structure.layout(line_item)?;
        let summary = self.summary_column(line_item, &layout, levels)?;
        let (shape, column) = &*summary;
        let target = Layout {
            axes: levels.0.clone(),
            restriction: layout.restriction,
        };
        let position = self
            .structure
            .resolve_cell(&target, coords)
            .map_err(|message| EngineError::InvalidCoordinate { message })?;
        Ok(decode(
            &self.structure,
            &line_item.format.value_type(),
            column.get(shape.index(&position)),
        ))
    }

    /// The cells of a line item, laid out as `layout`, rolled up to `levels`, from the cache
    /// when it is current. Levels that roll nothing up need no ratio parts.
    pub(crate) fn summary_column(
        &self,
        line_item: &LineItem,
        layout: &Layout,
        levels: &LevelSpec,
    ) -> Result<Arc<Summary>, EngineError> {
        let parts = if levels.0 == layout.axes {
            None
        } else {
            ratio_parts(line_item)?
        };
        let fingerprint = self.summaries.fingerprint(line_item.id, parts);
        if let Some(cached) = self.summaries.get(line_item.id, levels, &fingerprint) {
            return Ok(cached);
        }
        let shape = self.structure.shape_of(layout)?;
        let src = self.stored_column(line_item, &shape);
        let part_columns = parts
            .map(|(numerator, denominator)| {
                Ok::<_, EngineError>((
                    self.part_column(numerator, &shape)?,
                    self.part_column(denominator, &shape)?,
                ))
            })
            .transpose()?;
        let time_method = line_item
            .time_summary
            .as_ref()
            .unwrap_or(&line_item.summary);
        let rolled_up = aggregate(
            &self.structure,
            &shape,
            &src,
            &line_item.summary,
            time_method,
            levels,
            part_columns
                .as_ref()
                .map(|(numerator, denominator)| (&**numerator, &**denominator)),
        )?;
        let summary = Arc::new(rolled_up);
        self.summaries
            .insert(line_item.id, levels, fingerprint, Arc::clone(&summary));
        Ok(summary)
    }

    /// The cells of a line item over `shape`, typed in or calculated; blank for a calculated
    /// line item that has not been computed.
    fn stored_column(&self, line_item: &LineItem, shape: &Shape) -> Arc<Column> {
        let column = self
            .inputs
            .get(&line_item.id)
            .or_else(|| self.computed.get(&line_item.id));
        column.map_or_else(
            || {
                Arc::new(Column::new_blank(
                    &line_item.format.value_type(),
                    shape.size(),
                ))
            },
            Arc::clone,
        )
    }

    /// The cells of a ratio part, which must be laid out like the ratio's own.
    fn part_column(&self, id: LineItemId, shape: &Shape) -> Result<Arc<Column>, EngineError> {
        let part = ratio_part(&self.structure, id, shape)?;
        Ok(self.stored_column(part, shape))
    }

    fn empty_change_set(&self) -> ChangeSet {
        ChangeSet {
            generation: self.generation,
            changed_line_items: Vec::new(),
            structure_changed: false,
        }
    }

    fn apply_command(
        &mut self,
        command: Command,
        changes: &mut ChangeSet,
    ) -> Result<(), EngineError> {
        if let Command::SetCells { line_item, edits } = command {
            return self.set_cells(line_item, &edits, changes);
        }
        let old = Arc::clone(&self.structure);
        let old_inputs = self.inputs.clone();
        let result = self.apply_structural(command, &old, changes);
        if result.is_err() {
            self.structure = old;
            self.inputs = old_inputs;
        }
        result
    }

    fn apply_structural(
        &mut self,
        command: Command,
        old: &Structure,
        changes: &mut ChangeSet,
    ) -> Result<(), EngineError> {
        let deleted_items = match &command {
            Command::DeleteListItems { list, ids } => old.list(*list).map(|source| {
                let indices: HashSet<u32> = ids.iter().filter_map(|id| source.idx(*id)).collect();
                (*list, indices)
            }),
            _ => None,
        };
        Arc::make_mut(&mut self.structure).apply(command)?;
        changes.structure_changed = true;
        self.reconcile_inputs(old, changes)?;
        if let Some((list, indices)) = deleted_items {
            self.blank_item_cells(list, &indices, changes);
        }
        Ok(())
    }

    /// Brings the stored input columns in line with the structure after a change from `old`:
    /// creates columns for new input line items, drops those of deleted or calculated ones,
    /// clears columns whose axes, type or time scale changed (and, when the calendar's years
    /// or fiscal start month changed, those with a Time axis or period values), and lays the
    /// rest out again by coordinate when items, subset members or versions came or went.
    fn reconcile_inputs(
        &mut self,
        old: &Structure,
        changes: &mut ChangeSet,
    ) -> Result<(), EngineError> {
        let new = Arc::clone(&self.structure);
        let stale: Vec<LineItemId> = self
            .computed
            .iter()
            .filter(|(id, column)| {
                !new.line_item(**id)
                    .is_some_and(|li| li.formula.is_some() && fits(&new, li, column))
            })
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            self.computed.remove(&id);
            changes.note(id);
        }
        self.errors
            .retain(|id, _| new.line_item(*id).is_some_and(|li| li.formula.is_some()));
        let time_changed = old.calendar.years != new.calendar.years
            || old.calendar.fiscal_year_start_month != new.calendar.fiscal_year_start_month;
        for line_item in old.line_items().filter(|li| new.line_item(li.id).is_none()) {
            changes.note(line_item.id);
        }
        for line_item in new.line_items().filter(|li| old.line_item(li.id).is_none()) {
            changes.note(line_item.id);
        }
        let dropped: Vec<LineItemId> = self
            .inputs
            .keys()
            .filter(|id| !new.line_item(**id).is_some_and(|li| li.formula.is_none()))
            .copied()
            .collect();
        for id in dropped {
            self.inputs.remove(&id);
            changes.note(id);
        }

        let mut axis_maps = AxisMaps::new(old, &new);
        for line_item in new.line_items().filter(|li| li.formula.is_none()) {
            let layout = new.layout(line_item)?;
            let shape = new.shape_of(&layout)?;
            let ty = line_item.format.value_type();
            let previous = self
                .inputs
                .get(&line_item.id)
                .zip(old.line_item(line_item.id));
            let column = match previous {
                None => Column::new_blank(&ty, shape.size()),
                Some((column, old_line_item)) => {
                    let old_layout = old.layout(old_line_item)?;
                    let reinterpreted = time_changed
                        && (shape.time_pos().is_some() || matches!(ty, ValueType::Period(_)));
                    let cleared = old_line_item.format.value_type() != ty
                        || old_layout != layout
                        || reinterpreted;
                    if cleared {
                        Column::new_blank(&ty, shape.size())
                    } else {
                        let maps = layout
                            .axes
                            .iter()
                            .map(|axis| axis_maps.get(axis, layout.restriction.as_deref()))
                            .collect::<Result<Vec<_>, _>>()?;
                        if maps.iter().all(|map| map.identity) {
                            continue;
                        }
                        let slices: Vec<&[Option<u32>]> =
                            maps.iter().map(|map| map.positions.as_slice()).collect();
                        column.remap(&old.shape_of(&old_layout)?, &shape, &slices)
                    }
                }
            };
            self.inputs.insert(line_item.id, Arc::new(column));
            changes.note(line_item.id);
        }
        Ok(())
    }

    /// Blanks list-formatted cells that point at deleted items of `list`.
    fn blank_item_cells(&mut self, list: ListId, doomed: &HashSet<u32>, changes: &mut ChangeSet) {
        let structure = Arc::clone(&self.structure);
        let formatted = structure
            .line_items()
            .filter(|li| li.formula.is_none() && li.format == Format::List { list });
        for line_item in formatted {
            let Some(column) = self.inputs.get_mut(&line_item.id) else {
                continue;
            };
            let points_at_doomed = matches!(&**column, Column::Item(cells) if cells.iter().any(|cell| doomed.contains(cell)));
            if !points_at_doomed {
                continue;
            }
            if let Column::Item(cells) = Arc::make_mut(column) {
                for cell in cells.iter_mut().filter(|cell| doomed.contains(cell)) {
                    *cell = BLANK_ITEM;
                }
            }
            changes.note(line_item.id);
        }
    }

    /// Validates every edit and, only if all are valid, writes them.
    fn set_cells(
        &mut self,
        id: LineItemId,
        edits: &[CellEdit],
        changes: &mut ChangeSet,
    ) -> Result<(), EngineError> {
        let structure = Arc::clone(&self.structure);
        let line_item = structure
            .line_item(id)
            .ok_or_else(|| missing_line_item(id))?;
        if line_item.formula.is_some() {
            return Err(EngineError::NotInput {
                line_item: line_item.name.clone(),
            });
        }
        let layout = structure.layout(line_item)?;
        let shape = structure.shape_of(&layout)?;
        let ty = line_item.format.value_type();

        let mut writes = Vec::with_capacity(edits.len());
        let mut issues = Vec::new();
        for (index, edit) in edits.iter().enumerate() {
            let position = structure
                .resolve_cell(&layout, &edit.coords)
                .map_err(|message| EngineError::InvalidCoordinate {
                    message: format!("Edit {index}: {message}"),
                })?;
            if structure.is_before_switchover(&layout, &position) {
                issues.push(CellIssue {
                    index,
                    message: SWITCHOVER_MESSAGE.to_string(),
                });
                continue;
            }
            match encode(&structure, &ty, &edit.value) {
                Ok(cell) => writes.push((shape.index(&position), cell)),
                Err(message) => issues.push(CellIssue { index, message }),
            }
        }
        if !issues.is_empty() {
            return Err(EngineError::InvalidValue { cells: issues });
        }
        if writes.is_empty() {
            return Ok(());
        }
        let column = self
            .inputs
            .entry(id)
            .or_insert_with(|| Arc::new(Column::new_blank(&ty, shape.size())));
        let column = Arc::make_mut(column);
        for (position, cell) in writes {
            column.set(position, cell);
        }
        changes.note(id);
        Ok(())
    }
}

fn missing_line_item(id: LineItemId) -> EngineError {
    EngineError::NotFound {
        what: "line item",
        id: id.0.to_string(),
    }
}

/// Whether a calculated column still has the type and the number of cells its line item calls
/// for.
fn fits(structure: &Structure, line_item: &LineItem, column: &Column) -> bool {
    let kind_fits = matches!(
        (column, line_item.format.value_type()),
        (Column::Number(_), ValueType::Number)
            | (Column::Boolean(_), ValueType::Boolean)
            | (Column::Text(_), ValueType::Text)
            | (Column::Date(_), ValueType::Date)
            | (Column::Item(_), ValueType::Item(_))
            | (Column::Period(_), ValueType::Period(_))
    );
    kind_fits
        && structure
            .line_item_shape(line_item.id)
            .is_ok_and(|shape| shape.size() == column.len())
}

/// The part of a ratio summary with id `id`, which must be laid out over `shape`.
fn ratio_part<'a>(
    structure: &'a Structure,
    id: LineItemId,
    shape: &Shape,
) -> Result<&'a LineItem, EngineError> {
    let part = structure
        .line_item(id)
        .ok_or_else(|| missing_line_item(id))?;
    if structure.line_item_shape(id)? != *shape {
        return Err(EngineError::Invalid {
            message: format!(
                "Ratio part '{}' must have the same dimensions as the line item that divides it.",
                part.name
            ),
        });
    }
    Ok(part)
}

/// The values a recalculation reads: the cells typed into input line items and the calculated
/// ones computed so far. Calculated line items are read straight from here, never through the
/// summary cache, which holds the values of the last recalculation.
struct Working<'a> {
    structure: &'a Structure,
    inputs: &'a HashMap<LineItemId, Arc<Column>>,
    computed: HashMap<LineItemId, Arc<Column>>,
    /// Line items rolled up to the levels that formulas have asked for.
    rolled_up: Mutex<HashMap<(LineItemId, LevelSpec), Arc<Summary>>>,
}

impl Working<'_> {
    /// Records the values of a calculated line item and forgets the roll-ups that used its
    /// earlier values.
    fn insert(&mut self, id: LineItemId, column: Column) {
        self.computed.insert(id, Arc::new(column));
        let structure = self.structure;
        let uses = |rolled: &LineItemId| {
            structure
                .line_item(*rolled)
                .and_then(|li| ratio_parts(li).ok().flatten())
                .is_some_and(|(numerator, denominator)| numerator == id || denominator == id)
        };
        self.rolled_up
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|(rolled, _), _| *rolled != id && !uses(rolled));
    }
}

impl ColumnSource for Working<'_> {
    fn column(&self, id: LineItemId) -> Result<Arc<Column>, EngineError> {
        if let Some(column) = self.inputs.get(&id).or_else(|| self.computed.get(&id)) {
            return Ok(Arc::clone(column));
        }
        let line_item = self
            .structure
            .line_item(id)
            .ok_or_else(|| missing_line_item(id))?;
        let shape = self.structure.line_item_shape(id)?;
        Ok(Arc::new(Column::new_blank(
            &line_item.format.value_type(),
            shape.size(),
        )))
    }

    fn aggregated(&self, id: LineItemId, levels: &LevelSpec) -> Result<Arc<Summary>, EngineError> {
        let key = (id, levels.clone());
        let cached = |rolled_up: &HashMap<_, Arc<Summary>>| rolled_up.get(&key).map(Arc::clone);
        if let Some(found) = cached(
            &self
                .rolled_up
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        ) {
            return Ok(found);
        }
        let line_item = self
            .structure
            .line_item(id)
            .ok_or_else(|| missing_line_item(id))?;
        let shape = self.structure.line_item_shape(id)?;
        let src = self.column(id)?;
        let parts = ratio_parts(line_item)?
            .map(|(numerator, denominator)| {
                ratio_part(self.structure, numerator, &shape)?;
                ratio_part(self.structure, denominator, &shape)?;
                Ok::<_, EngineError>((self.column(numerator)?, self.column(denominator)?))
            })
            .transpose()?;
        let time_method = line_item
            .time_summary
            .as_ref()
            .unwrap_or(&line_item.summary);
        let rolled = Arc::new(aggregate(
            self.structure,
            &shape,
            &src,
            &line_item.summary,
            time_method,
            levels,
            parts
                .as_ref()
                .map(|(numerator, denominator)| (&**numerator, &**denominator)),
        )?);
        self.rolled_up
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, Arc::clone(&rolled));
        Ok(rolled)
    }
}

/// For one axis: where each position of the old layout lands in the new one.
struct AxisMap {
    positions: Vec<Option<u32>>,
    /// The axis holds the same items, versions or periods in the same places, tombstones
    /// of deleted items included.
    identity: bool,
}

/// Maps axis positions from an old structure to a new one by item, version or period
/// identity, remembering the maps because many line items share axes.
struct AxisMaps<'a> {
    old: &'a Structure,
    new: &'a Structure,
    cache: HashMap<(Axis, Option<Vec<VersionId>>), Rc<AxisMap>>,
}

impl<'a> AxisMaps<'a> {
    fn new(old: &'a Structure, new: &'a Structure) -> Self {
        AxisMaps {
            old,
            new,
            cache: HashMap::new(),
        }
    }

    fn get(
        &mut self,
        axis: &Axis,
        restriction: Option<&[VersionId]>,
    ) -> Result<Rc<AxisMap>, EngineError> {
        let key = (axis.clone(), restriction.map(<[VersionId]>::to_vec));
        if let Some(map) = self.cache.get(&key) {
            return Ok(Rc::clone(map));
        }
        let old_keys = self.old.axis_keys(axis, restriction)?;
        let new_keys = self.new.axis_keys(axis, restriction)?;
        let new_positions: HashMap<u128, u32> = new_keys
            .iter()
            .enumerate()
            .filter_map(|(position, key)| key.map(|key| (key, position as u32)))
            .collect();
        let positions: Vec<Option<u32>> = old_keys
            .iter()
            .map(|key| key.and_then(|key| new_positions.get(&key).copied()))
            .collect();
        let identity = old_keys == new_keys;
        let map = Rc::new(AxisMap {
            positions,
            identity,
        });
        self.cache.insert(key, Rc::clone(&map));
        Ok(map)
    }
}

/// Converts a submitted value into the storage form of a cell of type `ty`.
pub(crate) fn encode(structure: &Structure, ty: &ValueType, value: &Value) -> Result<Cell, String> {
    match (ty, value) {
        (ValueType::Number, Value::Number(number)) if number.is_finite() => {
            Ok(Cell::Number(*number))
        }
        (ValueType::Number, Value::Number(_)) => Err("Numbers must be finite.".to_string()),
        (ValueType::Boolean, Value::Boolean(flag)) => Ok(Cell::Boolean(*flag)),
        (ValueType::Text, Value::Text(text)) => Ok(Cell::Text(Arc::clone(text))),
        (ValueType::Date, Value::Date(date)) => Ok(Cell::Date(date.map_or(BLANK_DATE, |date| {
            date.num_days_from_ce() - EPOCH_DAYS_FROM_CE
        }))),
        (ValueType::Item(_), Value::Item(None)) => Ok(Cell::Item(BLANK_ITEM)),
        (ValueType::Item(list), Value::Item(Some(id))) => {
            let source = structure.list(*list);
            source
                .and_then(|source| source.idx(*id))
                .map(Cell::Item)
                .ok_or_else(|| {
                    format!(
                        "{} is not an item of list '{}'.",
                        id.0,
                        source.map_or("?", |source| source.name.as_str())
                    )
                })
        }
        (ValueType::Period(_), Value::Period(None)) => Ok(Cell::Period(BLANK_PERIOD)),
        (ValueType::Period(level), Value::Period(Some((found, index))))
            if found == level && *index < structure.calendar.periods(*level) =>
        {
            Ok(Cell::Period(*index))
        }
        (ValueType::Period(level), Value::Period(Some(_))) => Err(format!(
            "Expected a {} period of the calendar.",
            level_name(*level)
        )),
        _ => Err(format!("Expected {}.", expected(structure, ty))),
    }
}

fn expected(structure: &Structure, ty: &ValueType) -> String {
    match ty {
        ValueType::Number => "a number".to_string(),
        ValueType::Boolean => "a boolean".to_string(),
        ValueType::Text => "text".to_string(),
        ValueType::Date => "a date".to_string(),
        ValueType::Item(list) => format!(
            "an item of list '{}'",
            structure.list(*list).map_or("?", |list| list.name.as_str())
        ),
        ValueType::Period(level) => format!("a {} period", level_name(*level)),
    }
}

/// Converts a stored cell of type `ty` into a value. A cell that does not fit its type, which
/// the model never stores, reads as blank.
fn decode(structure: &Structure, ty: &ValueType, cell: Cell) -> Value {
    match (ty, cell) {
        (ValueType::Number, Cell::Number(number)) => Value::Number(number),
        (ValueType::Boolean, Cell::Boolean(flag)) => Value::Boolean(flag),
        (ValueType::Text, Cell::Text(text)) => Value::Text(text),
        (ValueType::Date, Cell::Date(days)) => Value::Date(
            (days != BLANK_DATE)
                .then(|| NaiveDate::from_num_days_from_ce_opt(days + EPOCH_DAYS_FROM_CE))
                .flatten(),
        ),
        (ValueType::Item(list), Cell::Item(idx)) => Value::Item(
            structure
                .list(*list)
                .filter(|source| idx < source.len_dense())
                .map(|source| source.item(idx).id),
        ),
        (ValueType::Period(level), Cell::Period(index)) => {
            Value::Period((index != BLANK_PERIOD).then_some((*level, index)))
        }
        (ty, _) => blank_value(ty),
    }
}

fn blank_value(ty: &ValueType) -> Value {
    match ty {
        ValueType::Number => Value::Number(0.0),
        ValueType::Boolean => Value::Boolean(false),
        ValueType::Text => Value::Text(Arc::from("")),
        ValueType::Date => Value::Date(None),
        ValueType::Item(_) => Value::Item(None),
        ValueType::Period(_) => Value::Period(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::ItemSpec;
    use crate::ids::{ItemId, ModuleId};
    use crate::structure::{AxisSpec, LineItem, SummaryMethod, TimeScale, VersionsScope};

    fn calendar() -> Calendar {
        Calendar {
            fiscal_year_start_month: 1,
            first_year: 2026,
            years: 1,
            current_month: None,
        }
    }

    #[test]
    fn unrelated_commands_leave_columns_of_lists_with_deleted_items_alone() {
        let mut model = Model::new(calendar());
        let products = ListId::new();
        let module = ModuleId::new();
        let units = LineItemId::new();
        let items: Vec<ItemId> = (0..3).map(|_| ItemId::new()).collect();
        model
            .apply_batch(vec![
                Command::CreateList {
                    id: products,
                    name: "Products".to_string(),
                    parent: None,
                    top_level_name: None,
                    numbered: false,
                    production_data: false,
                },
                Command::UpsertListItems {
                    list: products,
                    items: items
                        .iter()
                        .enumerate()
                        .map(|(position, id)| ItemSpec {
                            id: *id,
                            code: None,
                            name: format!("P{position}"),
                            parent: None,
                        })
                        .collect(),
                },
                Command::CreateModule {
                    id: module,
                    name: "Sales".to_string(),
                    axes: vec![AxisSpec::List { list: products }],
                    functional_area: String::new(),
                },
                Command::CreateLineItem(LineItem {
                    id: units,
                    module,
                    name: "Units".to_string(),
                    ordinal: 0,
                    format: Format::number(),
                    formula: None,
                    summary: SummaryMethod::Sum,
                    time_summary: None,
                    applies_to: None,
                    time_scale: TimeScale::Module,
                    versions: VersionsScope::Module,
                    notes: String::new(),
                    code: None,
                    read_access_driver: None,
                    write_access_driver: None,
                }),
            ])
            .unwrap();
        model
            .apply(Command::SetCells {
                line_item: units,
                edits: vec![CellEdit {
                    coords: vec![CoordToken::Item(items[2])],
                    value: Value::Number(3.0),
                }],
            })
            .unwrap();
        let deletion = model
            .apply(Command::DeleteListItems {
                list: products,
                ids: vec![items[1]],
            })
            .unwrap();
        assert_eq!(deletion.changed_line_items, vec![units]);

        let before = Arc::clone(&model.inputs[&units]);
        let changes = model
            .apply(Command::CreateList {
                id: ListId::new(),
                name: "Regions".to_string(),
                parent: None,
                top_level_name: None,
                numbered: false,
                production_data: false,
            })
            .unwrap();
        assert!(changes.changed_line_items.is_empty());
        assert!(Arc::ptr_eq(&before, &model.inputs[&units]));
    }
}
