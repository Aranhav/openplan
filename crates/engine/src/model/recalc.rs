//! Recalculation (spec §5.3): what a change leaves to calculate, and calculating it.
//!
//! A change names the cells it wrote, or the line items whose cells or definition it changed
//! as a whole. Everything that reads those is calculated again, layer by layer in the order of
//! the dependency graph: a line item that reads the changed cells one by one is calculated for
//! the cells that read them and no others, any other only whole. Line items of one layer are
//! calculated at the same time. A circular reference through time is calculated one period
//! after another.

use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use rayon::prelude::*;

use crate::command::ChangeSet;
use crate::error::{EngineError, FormulaError};
use crate::formula::{EvalCtx, eval_all, eval_cells};
use crate::graph::{Component, Formula, Graph, LinkKind};
use crate::ids::{LineItemId, ListId};
use crate::shape::Shape;
use crate::structure::{LineItem, Structure};
use crate::summary::ancestors;
use crate::value::Column;

use super::working::Working;
use super::{Model, RecalcStats};

/// A command or batch being applied: what it has changed so far, which is what is left to
/// calculate.
pub(super) struct Session {
    pub(super) changes: ChangeSet,
    /// The cells written to input line items, by position in their columns.
    written: HashMap<LineItemId, Vec<usize>>,
    /// The line items whose cells were created, deleted, cleared or laid out again as a whole.
    replaced: HashSet<LineItemId>,
    /// The line items whose formula was set, which are rejected if it has errors.
    touched: Vec<LineItemId>,
}

impl Session {
    pub(super) fn new(changes: ChangeSet) -> Session {
        Session {
            changes,
            written: HashMap::new(),
            replaced: HashSet::new(),
            touched: Vec::new(),
        }
    }

    pub(super) fn wrote(&mut self, line_item: LineItemId, cells: impl IntoIterator<Item = usize>) {
        self.changes.note(line_item);
        self.written.entry(line_item).or_default().extend(cells);
    }

    pub(super) fn replaced(&mut self, line_item: LineItemId) {
        self.changes.note(line_item);
        self.replaced.insert(line_item);
    }

    pub(super) fn touched(&mut self, line_item: LineItemId) {
        self.touched.push(line_item);
    }
}

/// Which cells of a line item changed, or need calculating.
enum Dirty {
    All,
    Cells(Vec<usize>),
}

impl Dirty {
    fn absorb(&mut self, other: Dirty) {
        match (&mut *self, other) {
            (Dirty::Cells(mine), Dirty::Cells(more)) => mine.extend(more),
            _ => *self = Dirty::All,
        }
    }
}

/// What a batch leaves to calculate.
#[derive(Default)]
struct Plan {
    /// The line items whose cells or definition changed, so that what reads them is calculated.
    changed: HashMap<LineItemId, Dirty>,
    /// The calculated line items to calculate whole whatever they read.
    recompute: HashSet<LineItemId>,
    /// The calculated line items whose formula does not compile and so have blank cells.
    broken: Vec<LineItemId>,
}

impl Plan {
    /// Adds what a change of structure from `before` to `after` leaves to calculate.
    fn add_structure(
        &mut self,
        (before, graph_before): (&Structure, &Graph),
        (after, graph): (&Structure, &Graph),
        computed: &HashMap<LineItemId, Arc<Column>>,
    ) -> Result<(), EngineError> {
        let environment = environment_changed(before, after);
        let roots = changed_roots(before, after, graph);
        for line_item in after.line_items() {
            let id = line_item.id;
            let reshaped = match before.line_item(id) {
                Some(old) => differs(before, old, after, line_item)?,
                None => true,
            };
            if line_item.formula.is_none() {
                if reshaped {
                    self.changed.insert(id, Dirty::All);
                }
                continue;
            }
            let missing = |size: usize| computed.get(&id).is_none_or(|column| column.len() != size);
            match graph.formula(id) {
                Some(formula) => {
                    let stale = reshaped
                        || environment
                        || missing(formula.shape.size())
                        || graph_before
                            .formula(id)
                            .is_none_or(|old| old.expr != formula.expr)
                        || formula
                            .lists
                            .iter()
                            .any(|&list| roots.contains(&root_of(after, list)));
                    if stale {
                        self.recompute.insert(id);
                    }
                }
                None => {
                    let unchanged = !reshaped
                        && graph_before.failure(id) == graph.failure(id)
                        && computed.contains_key(&id);
                    if !unchanged {
                        self.broken.push(id);
                        self.changed.insert(id, Dirty::All);
                    }
                }
            }
        }
        Ok(())
    }
}

/// Whether anything about a line item that its cells, or the cells that read them rolled up,
/// depend on differs between two structures.
fn differs(
    before: &Structure,
    old: &LineItem,
    after: &Structure,
    new: &LineItem,
) -> Result<bool, EngineError> {
    if old.format != new.format
        || old.summary != new.summary
        || old.time_summary != new.time_summary
        || old.applies_to != new.applies_to
        || old.time_scale != new.time_scale
        || old.versions != new.versions
    {
        return Ok(true);
    }
    let (old_layout, new_layout) = (before.layout(old)?, after.layout(new)?);
    Ok(old_layout != new_layout || before.shape_of(&old_layout)? != after.shape_of(&new_layout)?)
}

/// Whether the calendar, the time ranges or the versions (their names too, which formulas can
/// show) differ in a way that changes values anywhere.
fn environment_changed(before: &Structure, after: &Structure) -> bool {
    let versions = |structure: &Structure| {
        structure
            .versions()
            .iter()
            .map(|version| {
                (
                    version.id,
                    version.name.clone(),
                    version.is_actual,
                    version.is_current,
                    version.switchover,
                )
            })
            .collect::<Vec<_>>()
    };
    before.calendar != after.calendar
        || before.time_ranges().ne(after.time_ranges())
        || versions(before) != versions(after)
}

/// The top lists of the hierarchies that hold a list or subset used by a formula that changed.
fn changed_roots(before: &Structure, after: &Structure, graph: &Graph) -> HashSet<ListId> {
    let used: BTreeSet<ListId> = graph
        .formulas()
        .flat_map(|(_, formula)| formula.lists.iter().copied())
        .collect();
    let mut changed: HashSet<ListId> = used
        .iter()
        .copied()
        .filter(|&list| before.list(list) != after.list(list))
        .collect();
    for subset in before.subsets().chain(after.subsets()) {
        if used.contains(&subset.list) && before.subset(subset.id) != after.subset(subset.id) {
            changed.insert(subset.list);
        }
    }
    changed.iter().map(|&list| root_of(after, list)).collect()
}

/// The list at the top of the hierarchy that holds `list`.
fn root_of(structure: &Structure, list: ListId) -> ListId {
    ancestors(structure, list)
        .ok()
        .and_then(|chain| chain.last().copied())
        .unwrap_or(list)
}

impl Model {
    /// Calculates what a command or batch leaves to calculate, once its structure and cells
    /// are in place, and rejects it if a formula it set has errors.
    pub(super) fn settle(
        &mut self,
        session: Session,
        before: &Structure,
        graph_before: &Graph,
    ) -> Result<ChangeSet, EngineError> {
        let Session {
            mut changes,
            written,
            replaced,
            touched,
        } = session;
        let mut plan = Plan::default();
        for (id, cells) in written {
            let is_input = self
                .structure
                .line_item(id)
                .is_some_and(|li| li.formula.is_none());
            if is_input && !replaced.contains(&id) {
                plan.changed.insert(id, Dirty::Cells(cells));
            }
        }
        for id in replaced {
            plan.changed.insert(id, Dirty::All);
        }
        if changes.structure_changed {
            self.switched.clear();
            self.graph = Arc::new(Graph::build(&self.structure)?);
            plan.add_structure(
                (before, graph_before),
                (&self.structure, &self.graph),
                &self.computed,
            )?;
        }
        self.recalc(plan, &mut changes)?;
        for id in touched {
            let has_formula = self
                .structure
                .line_item(id)
                .is_some_and(|li| li.formula.is_some());
            if let Some(errors) = self.errors.get(&id).filter(|_| has_formula) {
                return Err(EngineError::Formula(errors.clone()));
            }
        }
        Ok(changes)
    }

    /// Calculates every calculated line item again from the cells typed in.
    pub(super) fn recalc_everything(&mut self, changes: &mut ChangeSet) -> Result<(), EngineError> {
        self.graph = Arc::new(Graph::build(&self.structure)?);
        self.computed.clear();
        self.switched.clear();
        self.errors.clear();
        let plan = Plan {
            changed: HashMap::new(),
            recompute: self.graph.formulas().map(|(id, _)| id).collect(),
            broken: self.graph.failures().map(|(id, _)| id).collect(),
        };
        self.recalc(plan, changes)
    }

    fn recalc(&mut self, plan: Plan, changes: &mut ChangeSet) -> Result<(), EngineError> {
        let structure = Arc::clone(&self.structure);
        let graph = Arc::clone(&self.graph);
        let Model {
            inputs,
            computed,
            switched,
            errors,
            stats,
            ..
        } = self;
        let working = Working::new(
            &structure,
            &graph,
            inputs,
            std::mem::take(computed),
            std::mem::take(switched),
        );
        let mut run = Run {
            structure: &structure,
            graph: &graph,
            working,
            errors,
            changes,
            stats: RecalcStats::default(),
            pending: HashMap::new(),
        };
        let outcome = run.go(plan);
        let Run {
            working,
            stats: done,
            ..
        } = run;
        let (calculated, shown) = working.into_parts();
        *computed = calculated;
        if outcome.is_ok() {
            *switched = shown;
        }
        *stats = done;
        outcome
    }
}

/// A recalculation in progress.
struct Run<'a> {
    structure: &'a Structure,
    graph: &'a Graph,
    working: Working<'a>,
    errors: &'a mut HashMap<LineItemId, Vec<FormulaError>>,
    changes: &'a mut ChangeSet,
    stats: RecalcStats,
    /// The calculated line items waiting for their turn, and which of their cells.
    pending: HashMap<LineItemId, Dirty>,
}

/// What calculating a line item gave.
enum Evaluated {
    Whole(Column),
    Cells(Vec<usize>, Column),
}

impl Run<'_> {
    fn go(&mut self, plan: Plan) -> Result<(), EngineError> {
        let Plan {
            changed,
            recompute,
            broken,
        } = plan;
        for id in broken {
            self.break_down(id)?;
        }
        for id in recompute {
            self.errors.remove(&id);
            self.pending.insert(id, Dirty::All);
        }
        for (id, dirty) in changed {
            match &dirty {
                Dirty::All => self.working.forget(id),
                Dirty::Cells(cells) => self.working.wrote(id, cells),
            }
            self.mark(id, &dirty);
        }
        let graph = self.graph;
        for layer in graph.layers() {
            let (cycles, singles): (Vec<&Component>, Vec<&Component>) = layer
                .iter()
                .filter(|component| {
                    component
                        .members
                        .iter()
                        .any(|member| self.pending.contains_key(member))
                })
                .partition(|component| component.cyclic);
            self.run_singles(&singles);
            for component in cycles {
                self.run_cycle(component);
            }
        }
        Ok(())
    }

    /// Gives a line item whose formula does not compile blank cells and its errors.
    fn break_down(&mut self, id: LineItemId) -> Result<(), EngineError> {
        let Some(line_item) = self.structure.line_item(id) else {
            return Ok(());
        };
        let shape = self.structure.line_item_shape(id)?;
        let blank = Column::new_blank(&line_item.format.value_type(), shape.size());
        self.working.insert(id, blank);
        let errors = self.graph.failure(id).unwrap_or_default();
        self.errors.insert(id, errors.to_vec());
        self.changes.note(id);
        self.mark(id, &Dirty::All);
        Ok(())
    }

    /// Notes that cells of `source` changed, for the line items that read them.
    fn mark(&mut self, source: LineItemId, changed: &Dirty) {
        let graph = self.graph;
        for link in graph.links_from(source) {
            let dirty = match (&link.kind, changed) {
                (LinkKind::Aligned(alignment), Dirty::Cells(cells)) => {
                    alignment.project(cells).map_or(Dirty::All, Dirty::Cells)
                }
                _ => Dirty::All,
            };
            match self.pending.entry(link.target) {
                Entry::Occupied(mut waiting) => waiting.get_mut().absorb(dirty),
                Entry::Vacant(vacant) => {
                    vacant.insert(dirty);
                }
            }
        }
    }

    /// Takes the cells of a line item that are due, as many as are worth calculating one by one.
    fn due(&mut self, id: LineItemId) -> Dirty {
        let size = self
            .graph
            .formula(id)
            .map_or(0, |formula| formula.shape.size());
        match self.pending.remove(&id).unwrap_or(Dirty::All) {
            Dirty::Cells(mut cells) => {
                cells.sort_unstable();
                cells.dedup();
                let sparse = cells.len() * 2 < size
                    && self.working.computed_len(id) == Some(size)
                    && !self.errors.contains_key(&id);
                if sparse {
                    Dirty::Cells(cells)
                } else {
                    Dirty::All
                }
            }
            all => all,
        }
    }

    /// Calculates the line items that are not part of a cycle, all at the same time.
    fn run_singles(&mut self, singles: &[&Component]) {
        let graph = self.graph;
        let jobs: Vec<(LineItemId, &Formula, Dirty)> = singles
            .iter()
            .filter_map(|component| {
                let id = component.members[0];
                graph.formula(id).map(|formula| (id, formula, self.due(id)))
            })
            .collect();
        let (structure, working) = (self.structure, &self.working);
        let outcomes: Vec<(LineItemId, Result<Evaluated, Vec<FormulaError>>)> = jobs
            .into_par_iter()
            .map(|(id, formula, dirty)| (id, evaluate(structure, working, formula, dirty)))
            .collect();
        for (id, outcome) in outcomes {
            self.finish(id, outcome);
        }
    }

    /// Takes in what calculating a line item gave.
    fn finish(&mut self, id: LineItemId, outcome: Result<Evaluated, Vec<FormulaError>>) {
        let changed = match outcome {
            Ok(Evaluated::Whole(column)) => {
                self.stats.evaluated_cells += column.len();
                self.working.insert(id, column);
                self.errors.remove(&id);
                Dirty::All
            }
            Ok(Evaluated::Cells(cells, values)) => {
                self.stats.evaluated_cells += cells.len();
                self.working.patch(id, &cells, &values);
                Dirty::Cells(cells)
            }
            Err(problems) => {
                self.blank(id);
                self.errors.insert(id, problems);
                Dirty::All
            }
        };
        self.stats.line_items += 1;
        self.changes.note(id);
        self.mark(id, &changed);
    }

    /// Gives a calculated line item blank cells.
    fn blank(&mut self, id: LineItemId) {
        if let Some(formula) = self.graph.formula(id) {
            self.working
                .insert(id, Column::new_blank(&formula.ty, formula.shape.size()));
        }
    }

    /// Calculates the line items of a circular reference one period after another, each period
    /// in the order the line items read each other in.
    fn run_cycle(&mut self, component: &Component) {
        let graph = self.graph;
        let members: Vec<_> = component
            .members
            .iter()
            .filter_map(|&id| graph.formula(id).map(|formula| (id, formula)))
            .collect();
        for (id, formula) in &members {
            self.pending.remove(id);
            self.errors.remove(id);
            self.working
                .insert(*id, Column::new_blank(&formula.ty, formula.shape.size()));
        }
        let periods = members
            .first()
            .and_then(|(_, formula)| {
                let shape = &formula.shape;
                shape.time_pos().map(|time| shape.lens[time])
            })
            .unwrap_or(0);
        let mut failed = HashSet::new();
        for period in 0..periods {
            for (id, formula) in &members {
                let Some(time) = formula.shape.time_pos().filter(|_| !failed.contains(id)) else {
                    continue;
                };
                let cells = period_cells(&formula.shape, time, period);
                let result = {
                    let ctx = EvalCtx::new(self.structure, &self.working, &formula.layout);
                    eval_cells(&ctx, &formula.shape, &formula.expr, &cells)
                };
                self.stats.evaluated_cells += cells.len();
                match result {
                    Ok(values) => self.working.patch(*id, &cells, &values),
                    Err(error) => {
                        failed.insert(*id);
                        self.errors.insert(*id, formula_errors(error));
                        self.blank(*id);
                    }
                }
            }
        }
        for (id, _) in &members {
            self.stats.line_items += 1;
            self.changes.note(*id);
            self.mark(*id, &Dirty::All);
        }
    }
}

/// The cells of a line item in one period.
fn period_cells(shape: &Shape, time: usize, period: u32) -> Vec<usize> {
    let (stride, len) = (shape.strides[time], shape.lens[time] as usize);
    if stride * len == 0 {
        return Vec::new();
    }
    let blocks = shape.size() / (stride * len);
    (0..blocks)
        .flat_map(|block| {
            let first = block * stride * len + period as usize * stride;
            first..first + stride
        })
        .collect()
}

/// Calculates a line item, whole or for some of its cells.
fn evaluate(
    structure: &Structure,
    working: &Working,
    formula: &Formula,
    dirty: Dirty,
) -> Result<Evaluated, Vec<FormulaError>> {
    let ctx = EvalCtx::new(structure, working, &formula.layout);
    match dirty {
        Dirty::All => eval_all(&ctx, &formula.shape, &formula.expr).map(Evaluated::Whole),
        Dirty::Cells(cells) => eval_cells(&ctx, &formula.shape, &formula.expr, &cells)
            .map(|values| Evaluated::Cells(cells, values)),
    }
    .map_err(formula_errors)
}

/// The problems of a formula that could not be evaluated, as formula errors.
fn formula_errors(error: EngineError) -> Vec<FormulaError> {
    match error {
        EngineError::Formula(errors) => errors,
        other => vec![FormulaError {
            code: other.code(),
            message: other.to_string(),
            start: 0,
            end: 0,
            suggestion: None,
        }],
    }
}
