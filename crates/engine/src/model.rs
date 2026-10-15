use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

use chrono::{Datelike, NaiveDate};

use crate::calendar::Calendar;
use crate::command::{CellEdit, ChangeSet, Command, CoordToken, LineItemPatch};
use crate::error::{CellIssue, EngineError, FormulaError};
use crate::formula::{ColumnSource, Completion, completions};
use crate::graph::Graph;
use crate::ids::{LineItemId, ListId, VersionId};
use crate::shape::{Axis, Shape};
use crate::structure::{Layout, LineItem, Structure, level_name};
use crate::summary::{LevelSpec, Summary, SummaryCache, ratio_parts, roll_up};
use crate::value::{BLANK_DATE, BLANK_ITEM, BLANK_PERIOD, Cell, Column, Format, Value, ValueType};

mod read;
mod recalc;
mod working;

use recalc::{Session, formula_errors};
use working::{Working, summarised_by_formula};

/// Days from 0001-01-01 (day 1 of the common era) to 1970-01-01.
pub(crate) const EPOCH_DAYS_FROM_CE: i32 = 719_163;

const SWITCHOVER_MESSAGE: &str = "Periods before the switchover show Actual values.";

/// The most characters a text cell holds.
const MAX_TEXT_CHARS: usize = 10_000;

/// What the last command, batch or full recalculation calculated.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RecalcStats {
    /// Cells of calculated line items that were evaluated: the target cells only. A formula
    /// evaluated for some of its cells may still run a scan over its whole line item, such as
    /// `CUMULATE`, which these cells do not count.
    pub evaluated_cells: usize,
    /// Calculated line items that were evaluated, wholly or in part.
    pub line_items: usize,
}

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
    /// The cells of the line items with Time and Versions axes as formulas read them, once a
    /// version has a switchover, which a recalculation keeps in line with the cells it writes.
    switched: HashMap<LineItemId, Arc<Column>>,
    /// The compiled formulas of the calculated line items, and what reads what.
    graph: Arc<Graph>,
    stats: RecalcStats,
    generation: u64,
    summaries: SummaryCache,
    /// How many stored cells the model was loaded without.
    load_warnings: usize,
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
            switched: HashMap::new(),
            graph: Arc::new(Graph::default()),
            stats: RecalcStats::default(),
            generation: 0,
            summaries: SummaryCache::default(),
            load_warnings: 0,
        }
    }

    /// A model over `structure` that holds `inputs` as the cells typed in, with every
    /// calculated line item calculated. `load_warnings` is how many stored cells were left out
    /// of `inputs`.
    pub(crate) fn assemble(
        structure: Structure,
        inputs: HashMap<LineItemId, Column>,
        load_warnings: usize,
    ) -> Result<Model, EngineError> {
        let mut model = Model::new(structure.calendar);
        model.structure = Arc::new(structure);
        model.inputs = inputs
            .into_iter()
            .map(|(id, column)| (id, Arc::new(column)))
            .collect();
        model.load_warnings = load_warnings;
        model.recalc_all()?;
        Ok(model)
    }

    pub fn structure(&self) -> &Structure {
        &self.structure
    }

    /// How many stored cells [`Model::from_parts`] left out because the coordinates, items or
    /// line items they belong to are not in the structure it was given. Zero for a model that
    /// was not loaded.
    pub fn load_warnings(&self) -> usize {
        self.load_warnings
    }

    /// The cells typed into an input line item, if it has any stored.
    pub(crate) fn input_cells(&self, li: LineItemId) -> Option<&Column> {
        self.inputs.get(&li).map(|column| &**column)
    }

    /// Counts the applied commands and batches.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Applies one command and calculates what it changes. A rejected command leaves the model
    /// unchanged.
    ///
    /// A command that sets a formula is rejected, with the problems found, if the formula does
    /// not compile or makes a circular reference that is not allowed. A command that breaks a
    /// formula already set, such as deleting a line item it reads, is not: the formula's line
    /// item has blank cells and its problems in [`Model::line_item_errors`] until it compiles
    /// again.
    pub fn apply(&mut self, cmd: Command) -> Result<ChangeSet, EngineError> {
        self.apply_batch(vec![cmd])
    }

    /// Applies the commands in order as one change, all or nothing, and calculates what they
    /// change once at the end.
    pub fn apply_batch(&mut self, cmds: Vec<Command>) -> Result<ChangeSet, EngineError> {
        if cmds.is_empty() {
            return Ok(self.empty_change_set());
        }
        if cmds.iter().all(|cmd| cell_edits(cmd).is_some()) {
            return self.run_cells(&cmds);
        }
        let mut work = self.clone();
        let changes = work.run(cmds)?;
        *self = work;
        Ok(changes)
    }

    /// Calculates every line item that has a formula again, each from the cells typed in, and
    /// returns the line items it calculated.
    ///
    /// Commands calculate what they change, so this is only needed to start over. A line item
    /// whose formula does not resolve, or cannot be aligned with the line items it reads, gets
    /// blank values and the problems in [`Model::line_item_errors`].
    pub fn recalc_all(&mut self) -> Result<ChangeSet, EngineError> {
        let mut changes = self.empty_change_set();
        self.recalc_everything(&mut changes)?;
        self.generation += 1;
        changes.generation = self.generation;
        self.summaries.record(&self.structure, &changes);
        Ok(changes)
    }

    /// What the last command, batch or full recalculation calculated.
    pub fn last_recalc_stats(&self) -> RecalcStats {
        self.stats
    }

    /// What is wrong with the formula of a calculated line item that has no values because of
    /// it, as of the last recalculation.
    pub fn line_item_errors(&self, li: LineItemId) -> Option<&[FormulaError]> {
        self.errors.get(&li).map(Vec::as_slice)
    }

    /// Checks `src` as the formula of the line item `li` without changing the model, and
    /// returns the type it would have, which is that of the line item's format, or every problem
    /// that setting it would be rejected for. That includes problems with the dimensions of the
    /// line items it reads and circular references, which are found by trying the formula on a
    /// copy of the model, so the cost is that of setting it.
    ///
    /// A blank formula is none, which makes the line item an input and is always valid. A line
    /// item that does not exist is reported as a problem with code `structure.not_found`.
    pub fn check_formula(&self, li: LineItemId, src: &str) -> Result<ValueType, Vec<FormulaError>> {
        let Some(line_item) = self.structure.line_item(li) else {
            return Err(formula_errors(missing_line_item(li)));
        };
        let ty = line_item.format.value_type();
        if src.trim().is_empty() {
            return Ok(ty);
        }
        let patch = LineItemPatch {
            formula: Some(Some(src.to_string())),
            ..LineItemPatch::default()
        };
        self.clone()
            .apply(Command::UpdateLineItem { id: li, patch })
            .map(|_| ty)
            .map_err(formula_errors)
    }

    /// What the formula editor offers after `prefix` in the formula of the line item `li`: line
    /// items, lists, functions and keywords, those of the line item's own module first. See
    /// [`Completion`]. Empty for a line item that does not exist.
    pub fn completions(&self, li: LineItemId, prefix: &str) -> Vec<Completion> {
        completions(&self.structure, li, prefix)
    }

    /// Reads leaf cells of a line item, each addressed by one token per axis.
    ///
    /// A calculated line item shows the values calculated by the last command; one whose
    /// formula has errors reads as blank.
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
        let summary = if summarised_by_formula(line_item, &shape, levels) {
            self.working().aggregated(line_item.id, levels)?
        } else {
            let src = self.stored_column(line_item, &shape);
            let part_columns = parts
                .map(|(numerator, denominator)| {
                    Ok::<_, EngineError>((
                        self.part_column(numerator, &shape)?,
                        self.part_column(denominator, &shape)?,
                    ))
                })
                .transpose()?;
            Arc::new(roll_up(
                &self.structure,
                line_item,
                &shape,
                layout.restriction.as_deref(),
                &src,
                part_columns
                    .as_ref()
                    .map(|(numerator, denominator)| (&**numerator, &**denominator)),
                levels,
            )?)
        };
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

    /// The values of the line items as formulas read them.
    fn working(&self) -> Working<'_> {
        Working::new(
            &self.structure,
            &self.graph,
            &self.inputs,
            self.computed.clone(),
            self.switched.clone(),
        )
    }

    fn empty_change_set(&self) -> ChangeSet {
        ChangeSet {
            generation: self.generation,
            changed_line_items: Vec::new(),
            structure_changed: false,
        }
    }

    /// Applies the commands in order to the model itself and calculates what they change. A
    /// command that fails leaves the model half changed, so the caller discards it; that is
    /// why `apply_batch` runs this on a copy.
    fn run(&mut self, commands: Vec<Command>) -> Result<ChangeSet, EngineError> {
        let before = Arc::clone(&self.structure);
        let graph_before = Arc::clone(&self.graph);
        let mut session = Session::new(self.empty_change_set());
        for command in commands {
            self.stage(command, &mut session)?;
        }
        self.finish(session, &before, &graph_before)
    }

    /// Writes the cells that commands of `SetCells` set, if all of them are valid, and
    /// calculates what they change, without copying the columns they write.
    fn run_cells(&mut self, commands: &[Command]) -> Result<ChangeSet, EngineError> {
        let writes = commands
            .iter()
            .filter_map(cell_edits)
            .map(|(line_item, edits)| self.check_cells(line_item, edits))
            .collect::<Result<Vec<_>, _>>()?;
        let before = Arc::clone(&self.structure);
        let graph_before = Arc::clone(&self.graph);
        let mut session = Session::new(self.empty_change_set());
        for write in writes {
            self.write_cells(write, &mut session);
        }
        self.finish(session, &before, &graph_before)
    }

    /// Calculates what a session has changed and counts it as one change of the model.
    fn finish(
        &mut self,
        session: Session,
        before: &Structure,
        graph_before: &Graph,
    ) -> Result<ChangeSet, EngineError> {
        let mut changes = self.settle(session, before, graph_before)?;
        self.generation += 1;
        changes.generation = self.generation;
        self.summaries.record(&self.structure, &changes);
        Ok(changes)
    }

    /// Puts the structure and cells a command changes in place, leaving the calculated cells
    /// that depend on them for the end of the batch.
    fn stage(&mut self, command: Command, session: &mut Session) -> Result<(), EngineError> {
        match &command {
            Command::SetCells { line_item, edits } => {
                let write = self.check_cells(*line_item, edits)?;
                self.write_cells(write, session);
                return Ok(());
            }
            Command::CreateLineItem(line_item) if line_item.formula.is_some() => {
                session.touched(line_item.id);
            }
            Command::UpdateLineItem { id, patch } if matches!(patch.formula, Some(Some(_))) => {
                session.touched(*id);
            }
            _ => {}
        }
        let old = Arc::clone(&self.structure);
        self.apply_structural(command, &old, session)
    }

    fn apply_structural(
        &mut self,
        command: Command,
        old: &Structure,
        session: &mut Session,
    ) -> Result<(), EngineError> {
        let deleted_items = match &command {
            Command::DeleteListItems { list, ids } => old.list(*list).map(|source| {
                let indices: HashSet<u32> = ids.iter().filter_map(|id| source.idx(*id)).collect();
                (*list, indices)
            }),
            _ => None,
        };
        Arc::make_mut(&mut self.structure).apply(command)?;
        session.changes.structure_changed = true;
        self.reconcile_inputs(old, session)?;
        if let Some((list, indices)) = deleted_items {
            self.blank_item_cells(list, &indices, session);
        }
        Ok(())
    }

    /// Brings the stored input columns in line with the structure after a change from `old`:
    /// creates columns for new input line items, drops those of deleted or calculated ones,
    /// clears columns whose axes, type or time scale changed (and, when the calendar's years
    /// or fiscal start month changed, those with a Time axis or period values), and lays the
    /// rest out again by coordinate when items, subset members or versions came or went.
    /// Calculated columns are not laid out again, since the next recalculation fills them in;
    /// they are dropped when any of that applies to them, so that none is read at coordinates
    /// it was not calculated for.
    fn reconcile_inputs(
        &mut self,
        old: &Structure,
        session: &mut Session,
    ) -> Result<(), EngineError> {
        let new = Arc::clone(&self.structure);
        let time_changed = old.calendar.years != new.calendar.years
            || old.calendar.fiscal_year_start_month != new.calendar.fiscal_year_start_month;
        let mut axis_maps = AxisMaps::new(old, &new);
        let mut stale = Vec::new();
        for (id, column) in &self.computed {
            if !computed_survives(old, &new, &mut axis_maps, time_changed, *id, column)? {
                stale.push(*id);
            }
        }
        for id in stale {
            self.computed.remove(&id);
            session.replaced(id);
        }
        self.errors
            .retain(|id, _| new.line_item(*id).is_some_and(|li| li.formula.is_some()));
        for line_item in old.line_items().filter(|li| new.line_item(li.id).is_none()) {
            session.replaced(line_item.id);
        }
        for line_item in new.line_items().filter(|li| old.line_item(li.id).is_none()) {
            session.replaced(line_item.id);
        }
        let dropped: Vec<LineItemId> = self
            .inputs
            .keys()
            .filter(|id| !new.line_item(**id).is_some_and(|li| li.formula.is_none()))
            .copied()
            .collect();
        for id in dropped {
            self.inputs.remove(&id);
            session.replaced(id);
        }

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
            session.replaced(line_item.id);
        }
        Ok(())
    }

    /// Blanks list-formatted cells, typed in or calculated, that point at deleted items of `list`.
    fn blank_item_cells(&mut self, list: ListId, doomed: &HashSet<u32>, session: &mut Session) {
        let structure = Arc::clone(&self.structure);
        let formatted = structure
            .line_items()
            .filter(|li| li.format == Format::List { list });
        for line_item in formatted {
            let columns = if line_item.formula.is_none() {
                &mut self.inputs
            } else {
                &mut self.computed
            };
            let Some(column) = columns.get_mut(&line_item.id) else {
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
            session.replaced(line_item.id);
        }
    }

    /// Validates every edit of a `SetCells` command and works out the cells to write.
    fn check_cells(&self, id: LineItemId, edits: &[CellEdit]) -> Result<CellWrite, EngineError> {
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
            match encode(&structure, &ty, &edit.value).and_then(check_text) {
                Ok(cell) => writes.push((shape.index(&position), cell)),
                Err(message) => issues.push(CellIssue { index, message }),
            }
        }
        if !issues.is_empty() {
            return Err(EngineError::InvalidValue { cells: issues });
        }
        Ok(CellWrite {
            line_item: id,
            cells: writes,
            ty,
            size: shape.size(),
        })
    }

    fn write_cells(&mut self, write: CellWrite, session: &mut Session) {
        let CellWrite {
            line_item,
            cells,
            ty,
            size,
        } = write;
        if cells.is_empty() {
            return;
        }
        session.wrote(line_item, cells.iter().map(|(position, _)| *position));
        let column = self
            .inputs
            .entry(line_item)
            .or_insert_with(|| Arc::new(Column::new_blank(&ty, size)));
        let column = Arc::make_mut(column);
        for (position, cell) in cells {
            column.set(position, cell);
        }
    }
}

/// The cells a `SetCells` command writes, checked: their positions in the column of the line
/// item and their values.
struct CellWrite {
    line_item: LineItemId,
    cells: Vec<(usize, Cell)>,
    ty: ValueType,
    size: usize,
}

/// The line item and the edits of a command of `SetCells`.
fn cell_edits(command: &Command) -> Option<(LineItemId, &[CellEdit])> {
    match command {
        Command::SetCells { line_item, edits } => Some((*line_item, edits)),
        _ => None,
    }
}

fn missing_line_item(id: LineItemId) -> EngineError {
    EngineError::NotFound {
        what: "line item",
        id: id.0.to_string(),
    }
}

/// Whether the calculated column of line item `id` is still laid out as the structure now has
/// it: the line item is still calculated, its type, axes and time scale are the same and no
/// axis has gained, lost or moved an item, subset member, version or period.
fn computed_survives(
    old: &Structure,
    new: &Structure,
    axis_maps: &mut AxisMaps,
    time_changed: bool,
    id: LineItemId,
    column: &Column,
) -> Result<bool, EngineError> {
    let (Some(old_line_item), Some(line_item)) = (
        old.line_item(id),
        new.line_item(id).filter(|li| li.formula.is_some()),
    ) else {
        return Ok(false);
    };
    let ty = line_item.format.value_type();
    let layout = new.layout(line_item)?;
    let shape = new.shape_of(&layout)?;
    let reinterpreted =
        time_changed && (shape.time_pos().is_some() || matches!(ty, ValueType::Period(_)));
    if reinterpreted
        || old_line_item.format.value_type() != ty
        || old.layout(old_line_item)? != layout
        || column.len() != shape.size()
    {
        return Ok(false);
    }
    for axis in &layout.axes {
        if !axis_maps.get(axis, layout.restriction.as_deref())?.identity {
            return Ok(false);
        }
    }
    Ok(true)
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

/// Fails if a text cell is longer than a cell may be or holds the NUL character, which the
/// database cannot store.
fn check_text(cell: Cell) -> Result<Cell, String> {
    if let Cell::Text(text) = &cell {
        if text.chars().count() > MAX_TEXT_CHARS {
            return Err("Text is limited to 10,000 characters.".to_string());
        }
        if text.contains('\0') {
            return Err("Text can't contain the NUL character.".to_string());
        }
    }
    Ok(cell)
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
