//! The values a recalculation reads, and the roll-ups of them that formulas ask for.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use crate::error::EngineError;
use crate::formula::{ColumnSource, EvalCtx, eval_all};
use crate::graph::Graph;
use crate::ids::LineItemId;
use crate::shape::{Axis, Shape};
use crate::structure::{Layout, LineItem, Structure, SummaryMethod};
use crate::summary::{
    LevelSpec, Summary, ratio_parts, roll_up, show_written, with_actual_before_switchover,
};
use crate::value::Column;

use super::ratio_part;

/// The values a recalculation reads: the cells typed into input line items and the calculated
/// ones calculated so far. Calculated line items are read straight from here, never through the
/// summary cache, which holds the values of the last recalculation.
pub(super) struct Working<'a> {
    structure: &'a Structure,
    graph: &'a Graph,
    inputs: &'a HashMap<LineItemId, Arc<Column>>,
    computed: HashMap<LineItemId, Arc<Column>>,
    /// Line items rolled up to the levels that formulas have asked for.
    rolled_up: Mutex<HashMap<(LineItemId, LevelSpec), Arc<Summary>>>,
    /// Calculated or typed-in cells as formulas read them, where that differs from the cells.
    /// They outlive a recalculation, which keeps them in line with the cells it writes.
    switched: Mutex<HashMap<LineItemId, Arc<Column>>>,
}

/// Whether rolling `line_item`, laid out as `shape`, up to `levels` takes its formula rather
/// than its summary method: the line item is calculated, a hierarchy is rolled up with its
/// method and Time with its time summary method, and one of them is `Formula`.
pub(super) fn summarised_by_formula(
    line_item: &LineItem,
    shape: &Shape,
    levels: &LevelSpec,
) -> bool {
    if line_item.formula.is_none() {
        return false;
    }
    let time_method = line_item
        .time_summary
        .as_ref()
        .unwrap_or(&line_item.summary);
    let (mut time_rolls_up, mut lists_roll_up) = (false, false);
    for (from, to) in shape.axes.iter().zip(&levels.0) {
        if from == to {
            continue;
        }
        match from {
            Axis::Time { .. } => time_rolls_up = true,
            Axis::Versions => {}
            Axis::List(_) | Axis::Subset(_) | Axis::ListTop(_) => lists_roll_up = true,
        }
    }
    (lists_roll_up && line_item.summary == SummaryMethod::Formula)
        || (time_rolls_up && *time_method == SummaryMethod::Formula)
}

impl<'a> Working<'a> {
    pub(super) fn new(
        structure: &'a Structure,
        graph: &'a Graph,
        inputs: &'a HashMap<LineItemId, Arc<Column>>,
        computed: HashMap<LineItemId, Arc<Column>>,
        switched: HashMap<LineItemId, Arc<Column>>,
    ) -> Working<'a> {
        Working {
            structure,
            graph,
            inputs,
            computed,
            rolled_up: Mutex::default(),
            switched: Mutex::new(switched),
        }
    }

    /// The calculated cells and the cells as formulas read them.
    pub(super) fn into_parts(
        self,
    ) -> (
        HashMap<LineItemId, Arc<Column>>,
        HashMap<LineItemId, Arc<Column>>,
    ) {
        let switched = self
            .switched
            .into_inner()
            .unwrap_or_else(PoisonError::into_inner);
        (self.computed, switched)
    }

    /// The number of cells calculated for a line item, if it has been calculated.
    pub(super) fn computed_len(&self, id: LineItemId) -> Option<usize> {
        self.computed.get(&id).map(|column| column.len())
    }

    /// Records the values of a calculated line item and forgets the roll-ups that used its
    /// earlier values.
    pub(super) fn insert(&mut self, id: LineItemId, column: Column) {
        self.computed.insert(id, Arc::new(column));
        self.forget(id);
    }

    /// Overwrites some cells of a calculated line item that has values, and forgets the
    /// roll-ups that used its earlier values.
    pub(super) fn patch(&mut self, id: LineItemId, at: &[usize], values: &Column) {
        if let Some(column) = self.computed.get_mut(&id) {
            Arc::make_mut(column).scatter(at, values);
        }
        self.forget_rolled_up(id);
        self.wrote(id, at);
    }

    /// Takes note that some cells of a line item were written, so that the cells as formulas
    /// read them follow.
    pub(super) fn wrote(&mut self, id: LineItemId, at: &[usize]) {
        let Some(shown) = self
            .switched
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .get_mut(&id)
        else {
            return;
        };
        let updated = self
            .inputs
            .get(&id)
            .or_else(|| self.computed.get(&id))
            .zip(self.structure.line_item(id))
            .and_then(|(cells, line_item)| {
                let layout = self.structure.layout(line_item).ok()?;
                let shape = self.structure.shape_of(&layout).ok()?;
                show_written(
                    self.structure,
                    &shape,
                    layout.restriction.as_deref(),
                    (cells, at),
                    Arc::make_mut(shown),
                )
                .ok()
            });
        if updated.is_none() {
            self.switched
                .get_mut()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&id);
        }
    }

    /// Takes note that all the cells of a line item may have changed.
    pub(super) fn forget(&mut self, id: LineItemId) {
        self.forget_rolled_up(id);
        self.switched
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    }

    fn forget_rolled_up(&mut self, id: LineItemId) {
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

    /// The cells of a line item over its own shape: typed in, calculated so far or blank.
    fn cells(&self, id: LineItemId) -> Result<Arc<Column>, EngineError> {
        if let Some(column) = self.inputs.get(&id).or_else(|| self.computed.get(&id)) {
            return Ok(Arc::clone(column));
        }
        let line_item = self
            .structure
            .line_item(id)
            .ok_or_else(|| EngineError::not_found("line item", id.0))?;
        let shape = self.structure.line_item_shape(id)?;
        Ok(Arc::new(Column::new_blank(
            &line_item.format.value_type(),
            shape.size(),
        )))
    }

    /// The cells of a line item as formulas read them (see [`ColumnSource::column`]).
    fn shown(&self, id: LineItemId) -> Result<Arc<Column>, EngineError> {
        let lock = || self.switched.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(found) = lock().get(&id) {
            return Ok(Arc::clone(found));
        }
        let cells = self.cells(id)?;
        let line_item = self
            .structure
            .line_item(id)
            .ok_or_else(|| EngineError::not_found("line item", id.0))?;
        let layout = self.structure.layout(line_item)?;
        let shape = self.structure.shape_of(&layout)?;
        let switched = with_actual_before_switchover(
            self.structure,
            &shape,
            layout.restriction.as_deref(),
            &cells,
        )?;
        Ok(switched.map_or(cells, |switched| {
            let switched = Arc::new(switched);
            lock().insert(id, Arc::clone(&switched));
            switched
        }))
    }

    /// A line item rolled up to `levels` (see [`ColumnSource::aggregated`]), while the formula
    /// summaries in `active` are being worked out.
    fn rolled(
        &self,
        active: &[(LineItemId, LevelSpec)],
        id: LineItemId,
        levels: &LevelSpec,
    ) -> Result<Arc<Summary>, EngineError> {
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
            .ok_or_else(|| EngineError::not_found("line item", id.0))?;
        let layout = self.structure.layout(line_item)?;
        let shape = self.structure.shape_of(&layout)?;
        let rolled = if summarised_by_formula(line_item, &shape, levels) {
            if active.contains(&key) {
                return Err(EngineError::Invalid {
                    message: format!(
                        "The formula summary of line item '{}' reads itself.",
                        line_item.name
                    ),
                });
            }
            let mut chain = active.to_vec();
            chain.push(key.clone());
            let scope = Scope {
                working: self,
                active: chain,
            };
            self.evaluate_summary(&scope, line_item, &layout, levels)?
        } else {
            let src = self.cells(id)?;
            let parts = ratio_parts(line_item)?
                .map(|(numerator, denominator)| {
                    ratio_part(self.structure, numerator, &shape)?;
                    ratio_part(self.structure, denominator, &shape)?;
                    Ok::<_, EngineError>((self.cells(numerator)?, self.cells(denominator)?))
                })
                .transpose()?;
            roll_up(
                self.structure,
                line_item,
                &shape,
                layout.restriction.as_deref(),
                &src,
                parts
                    .as_ref()
                    .map(|(numerator, denominator)| (&**numerator, &**denominator)),
                levels,
            )?
        };
        let rolled = Arc::new(rolled);
        self.rolled_up
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, Arc::clone(&rolled));
        Ok(rolled)
    }

    /// The formula of `line_item` evaluated over the cells of `levels`, where what it reads is
    /// rolled up to those levels in turn. A line item whose formula does not compile has blank
    /// cells.
    fn evaluate_summary(
        &self,
        scope: &Scope,
        line_item: &LineItem,
        layout: &Layout,
        levels: &LevelSpec,
    ) -> Result<Summary, EngineError> {
        let target = Layout {
            axes: levels.0.clone(),
            restriction: layout.restriction.clone(),
        };
        let shape = self.structure.shape_of(&target)?;
        let Some(formula) = self.graph.formula(line_item.id) else {
            let blank = Column::new_blank(&line_item.format.value_type(), shape.size());
            return Ok((shape, blank));
        };
        let ctx = EvalCtx::new(self.structure, scope, &target);
        let column = eval_all(&ctx, &shape, &formula.expr)?;
        Ok((shape, column))
    }
}

impl ColumnSource for Working<'_> {
    fn column(&self, id: LineItemId) -> Result<Arc<Column>, EngineError> {
        self.shown(id)
    }

    fn aggregated(&self, id: LineItemId, levels: &LevelSpec) -> Result<Arc<Summary>, EngineError> {
        self.rolled(&[], id, levels)
    }
}

/// The values formulas read while the formula summaries in `active` are worked out, which may
/// not be asked for again.
struct Scope<'w, 'a> {
    working: &'w Working<'a>,
    active: Vec<(LineItemId, LevelSpec)>,
}

impl ColumnSource for Scope<'_, '_> {
    fn column(&self, id: LineItemId) -> Result<Arc<Column>, EngineError> {
        self.working.shown(id)
    }

    fn aggregated(&self, id: LineItemId, levels: &LevelSpec) -> Result<Arc<Summary>, EngineError> {
        self.working.rolled(&self.active, id, levels)
    }
}
