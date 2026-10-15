//! The dependency graph of the calculated line items (spec §5.3): which line items read which,
//! which cycles are allowed, the order to calculate in, and how a change in some cells of one
//! line item reaches the cells of those that read it.
//!
//! A line item's formula is compiled when the graph is built, so the graph also knows which
//! formulas do not compile. The edges run from a line item that is read to the line item that
//! reads it, and also from the line items that a rolled-up read needs: the mapping line items of
//! modifiers and the parts of a ratio summary.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::error::{EngineError, FormulaError};
use crate::formula::functions::FuncId;
use crate::formula::{SelectTarget, Span, TExpr, TModifier, UnOp, parse, resolve};
use crate::ids::{LineItemId, ListId};
use crate::shape::{Axis, Shape};
use crate::structure::{Layout, LineItem, Structure, SummaryMethod};
use crate::summary::{cutoffs, ratio_parts};
use crate::value::{Format, Value, ValueType};

mod order;

use order::Analysis;

/// The compiled formulas of a model's calculated line items, the order to calculate them in
/// and what reads what.
#[derive(Debug, Default)]
pub(crate) struct Graph {
    formulas: HashMap<LineItemId, Formula>,
    failures: HashMap<LineItemId, Vec<FormulaError>>,
    layers: Vec<Vec<Component>>,
    links: HashMap<LineItemId, Vec<Link>>,
}

/// A formula that compiles, and where its line item keeps its cells.
#[derive(Debug)]
pub(crate) struct Formula {
    pub expr: TExpr,
    pub ty: ValueType,
    pub layout: Layout,
    pub shape: Shape,
    /// The lists whose items or hierarchy the cells of the line item can depend on: those of
    /// its own dimensions and formats, of the line items it reads and of the formula itself.
    pub lists: Vec<ListId>,
}

/// Line items calculated together: one that nothing in its layer depends on, or the members of
/// a cycle through time, in the order to calculate them within a period.
#[derive(Debug)]
pub(crate) struct Component {
    pub members: Vec<LineItemId>,
    pub cyclic: bool,
}

/// What a line item's formula reads from another.
#[derive(Debug)]
pub(crate) struct Link {
    pub target: LineItemId,
    pub kind: LinkKind,
}

#[derive(Debug)]
pub(crate) enum LinkKind {
    /// Each cell of the target reads the cell of the source with the same coordinates: a change
    /// of some cells of the source changes those cells of the target and no others.
    Aligned(Box<Alignment>),
    /// A change of any cell of the source can change any cell of the target.
    Whole,
}

/// How the cells of a source line item line up with those of a target that reads it cell by
/// cell: every dimension of the source is a dimension of the target, and the target repeats the
/// source over the dimensions it adds. Where a version shows the actual version's cells before
/// its switchover, a target cell of that version reads the actual version's source cell.
#[derive(Clone, Debug)]
pub(crate) struct Alignment {
    source: Shape,
    target: Shape,
    /// The axis of the target that each axis of the source is.
    matched: Vec<usize>,
    /// The position, stride and length of each axis of the target that no axis of the source is.
    free: Vec<(usize, usize, usize)>,
    switchover: Option<Switchover>,
}

/// The periods of each version that show the actual version.
#[derive(Clone, Debug)]
struct Switchover {
    /// The Versions axis of the source and of the target.
    source_versions: usize,
    target_versions: usize,
    /// The Time axis of the target, whose periods decide, and the axis of the source that
    /// follows it, if the source has one.
    target_time: usize,
    source_time: Option<usize>,
    /// The position of the actual version along the Versions axis.
    actual: usize,
    /// For each version, how many leading periods show the actual version.
    cutoff: Vec<u32>,
}

impl Graph {
    /// Compiles every formula of `structure` and works out the order to calculate them in.
    pub(crate) fn build(structure: &Structure) -> Result<Graph, EngineError> {
        let mut formulas = HashMap::new();
        let mut failures = HashMap::new();
        for line_item in structure.line_items().filter(|li| li.formula.is_some()) {
            match compile(structure, line_item) {
                Ok(expr) => {
                    let layout = structure.layout(line_item)?;
                    let shape = structure.shape_of(&layout)?;
                    formulas.insert(
                        line_item.id,
                        Formula {
                            expr,
                            ty: line_item.format.value_type(),
                            layout,
                            shape,
                            lists: Vec::new(),
                        },
                    );
                }
                Err(errors) => {
                    failures.insert(line_item.id, errors);
                }
            }
        }
        let mut ids: Vec<LineItemId> = formulas.keys().copied().collect();
        ids.sort();
        let edges = ids
            .iter()
            .map(|id| edges_of(structure, &formulas, *id))
            .collect::<Result<Vec<_>, _>>()?;
        for (id, edges) in ids.iter().zip(&edges) {
            let lists = footprint(structure, &formulas, *id, edges)?;
            if let Some(formula) = formulas.get_mut(id) {
                formula.lists = lists;
            }
        }

        let analysis = Analysis::new(structure, &formulas, &ids, &edges);
        let mut valid = Vec::new();
        let mut broken = HashSet::new();
        for mut members in analysis.components() {
            members.sort_unstable();
            if !analysis.is_cyclic(&members) {
                valid.push((members, false));
                continue;
            }
            match analysis.order_cycle(&members) {
                Ok(order) => valid.push((order, true)),
                Err(cycle) => {
                    for (id, error) in analysis.cycle_errors(&members, &cycle) {
                        failures.insert(id, vec![error]);
                    }
                    broken.extend(members);
                }
            }
        }
        let layers = analysis.layers(&valid, &broken);
        let broken_ids: HashSet<LineItemId> = broken.iter().map(|&node| ids[node]).collect();
        let mut links: HashMap<LineItemId, Vec<Link>> = HashMap::new();
        for (target, edges) in ids.iter().zip(&edges) {
            if broken_ids.contains(target) {
                continue;
            }
            for edge in edges {
                let kind = match (&edge.alignment, edge.reads.pointwise) {
                    (Some(alignment), true) => LinkKind::Aligned(Box::new(alignment.clone())),
                    _ => LinkKind::Whole,
                };
                links.entry(edge.source).or_default().push(Link {
                    target: *target,
                    kind,
                });
            }
        }
        formulas.retain(|id, _| !broken_ids.contains(id));
        Ok(Graph {
            formulas,
            failures,
            layers,
            links,
        })
    }

    /// The compiled formula of a calculated line item, if it compiles and is not part of a
    /// circular reference.
    pub(crate) fn formula(&self, id: LineItemId) -> Option<&Formula> {
        self.formulas.get(&id)
    }

    pub(crate) fn formulas(&self) -> impl Iterator<Item = (LineItemId, &Formula)> {
        self.formulas.iter().map(|(id, formula)| (*id, formula))
    }

    /// What is wrong with the formula of a calculated line item that has no compiled formula.
    pub(crate) fn failure(&self, id: LineItemId) -> Option<&[FormulaError]> {
        self.failures.get(&id).map(Vec::as_slice)
    }

    pub(crate) fn failures(&self) -> impl Iterator<Item = (LineItemId, &[FormulaError])> {
        self.failures
            .iter()
            .map(|(id, errors)| (*id, errors.as_slice()))
    }

    /// The components in an order that calculates every line item after those it reads: all
    /// those of a layer can be calculated at the same time.
    pub(crate) fn layers(&self) -> &[Vec<Component>] {
        &self.layers
    }

    /// How the line items that read `source` read it.
    pub(crate) fn links_from(&self, source: LineItemId) -> &[Link] {
        self.links.get(&source).map_or(&[], Vec::as_slice)
    }
}

/// Parses and resolves the formula of a line item.
fn compile(structure: &Structure, line_item: &LineItem) -> Result<TExpr, Vec<FormulaError>> {
    let expr = parse(line_item.formula.as_deref().unwrap_or_default())?;
    resolve(structure, line_item.id, &expr)
}

/// How far into the periods around the current one a read goes, from the earliest to the
/// least known.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Reach {
    /// Always an earlier period: `PREVIOUS`, or `LAG` or `OFFSET` by a literal number of
    /// periods back.
    Backward,
    /// The current period.
    Same,
    /// The current period and earlier ones: `CUMULATE` and the to-date functions.
    Causal,
    /// Later periods, or periods that depend on the data.
    Other,
}

impl Reach {
    /// The reach of reading through something of reach `inner` that is itself read with reach
    /// `self`.
    fn then(self, inner: Reach) -> Reach {
        match (self, inner) {
            (Reach::Other, _) | (_, Reach::Other) => Reach::Other,
            (Reach::Backward, _) | (_, Reach::Backward) => Reach::Backward,
            (Reach::Causal, _) | (_, Reach::Causal) => Reach::Causal,
            (Reach::Same, Reach::Same) => Reach::Same,
        }
    }
}

/// What lies between the root of a formula and a reference in it.
#[derive(Clone, Copy, Debug)]
struct Path {
    /// Only operators and functions that work on each cell alone.
    pointwise: bool,
    reach: Reach,
}

impl Path {
    fn shifted(self, reach: Reach) -> Path {
        Path {
            pointwise: false,
            reach: self.reach.then(reach),
        }
    }
}

/// Everything a formula does with the cells of one line item it reads.
#[derive(Clone, Copy, Debug)]
struct Reads {
    /// Every reference is on a pointwise path.
    pointwise: bool,
    /// The widest reach of any reference.
    reach: Reach,
    /// A reference has modifiers, or the line item is read for the sake of another.
    modified: bool,
}

impl Reads {
    fn of(path: Path, modified: bool) -> Reads {
        Reads {
            pointwise: path.pointwise && !modified,
            reach: if modified { Reach::Other } else { path.reach },
            modified,
        }
    }

    fn merge(&mut self, other: Reads) {
        self.pointwise &= other.pointwise;
        self.reach = self.reach.max(other.reach);
        self.modified |= other.modified;
    }
}

/// How a function treats the cells of its arguments.
enum Kind {
    /// Each cell of the result is worked out from the same cell of the arguments.
    Cellwise,
    /// `PREVIOUS(x)`.
    Previous,
    /// `LAG(x, n, default)`.
    Lag,
    /// `OFFSET(x, n, default)`.
    Offset,
    /// Reads the cells from the first period of the line up to the current one.
    Running,
    /// Reads other cells, or all of them, in ways that depend on the data.
    Scan,
}

fn kind_of(func: FuncId) -> Kind {
    match func {
        FuncId::Abs
        | FuncId::Round
        | FuncId::Min
        | FuncId::Max
        | FuncId::Power
        | FuncId::Sqrt
        | FuncId::Exp
        | FuncId::Ln
        | FuncId::Log
        | FuncId::Mod
        | FuncId::Divide
        | FuncId::Sign
        | FuncId::IsBlank
        | FuncId::IsNotBlank
        | FuncId::IsAncestor
        | FuncId::Left
        | FuncId::Right
        | FuncId::Mid
        | FuncId::Len
        | FuncId::Find
        | FuncId::Upper
        | FuncId::Lower
        | FuncId::Trim
        | FuncId::Substitute
        | FuncId::Text
        | FuncId::Value
        | FuncId::Item
        | FuncId::Parent
        | FuncId::Name
        | FuncId::Code
        | FuncId::FindItem
        | FuncId::Start
        | FuncId::End
        | FuncId::InPeriod
        | FuncId::Period
        | FuncId::CurrentPeriodStart
        | FuncId::CurrentPeriodEnd
        | FuncId::Date
        | FuncId::Day
        | FuncId::Month
        | FuncId::Year
        | FuncId::Weekday
        | FuncId::AddMonths
        | FuncId::AddYears
        | FuncId::Days
        | FuncId::Pmt
        | FuncId::Pv
        | FuncId::Fv => Kind::Cellwise,
        FuncId::Previous => Kind::Previous,
        FuncId::Lag => Kind::Lag,
        FuncId::Offset => Kind::Offset,
        FuncId::Cumulate | FuncId::YearToDate | FuncId::QuarterToDate | FuncId::HalfYearToDate => {
            Kind::Running
        }
        FuncId::IsFirstOccurrence
        | FuncId::Next
        | FuncId::Lead
        | FuncId::MovingSum
        | FuncId::YearValue
        | FuncId::QuarterValue
        | FuncId::HalfYearValue
        | FuncId::MonthValue
        | FuncId::TimeSum
        | FuncId::CurrentVersion
        | FuncId::PreviousVersion
        | FuncId::NextVersion
        | FuncId::Rank
        | FuncId::Npv
        | FuncId::Irr => Kind::Scan,
    }
}

/// The number a formula writes as a literal, with a minus sign if it has one.
fn literal_number(expr: &TExpr) -> Option<f64> {
    match expr {
        TExpr::Const {
            value: Value::Number(number),
            ..
        } => Some(*number),
        TExpr::Unary {
            op: UnOp::Neg,
            expr,
            ..
        } => literal_number(expr).map(|number| -number),
        _ => None,
    }
}

/// The whole number of periods that a literal count stands for, dropping any fraction towards
/// zero, as the functions that shift by it do.
fn literal_steps(expr: &TExpr) -> Option<i64> {
    literal_number(expr).map(|number| number as i64)
}

/// Calls `visit` with every reference to a line item in `expr`, with the span of the reference
/// and what lies between it and the root of the formula. The mapping line items of modifiers
/// count as references that modifiers sit on.
fn walk(expr: &TExpr, path: Path, visit: &mut dyn FnMut(LineItemId, Span, Path, bool)) {
    match expr {
        TExpr::LineItem {
            id,
            modifiers,
            span,
            ..
        } => {
            visit(*id, *span, path, !modifiers.is_empty());
            for modifier in modifiers {
                if let TModifier::Sum(mapping)
                | TModifier::Lookup(mapping)
                | TModifier::Agg(_, mapping) = modifier
                {
                    visit(*mapping, *span, path, true);
                }
            }
        }
        TExpr::Unary { expr, .. } => walk(expr, path, visit),
        TExpr::Binary { lhs, rhs, .. } => {
            walk(lhs, path, visit);
            walk(rhs, path, visit);
        }
        TExpr::If {
            cond, then, els, ..
        } => {
            for part in [cond, then, els] {
                walk(part, path, visit);
            }
        }
        TExpr::Call { func, args, .. } => walk_call(*func, args, path, visit),
        TExpr::Const { .. }
        | TExpr::ListItemConst { .. }
        | TExpr::VersionConst { .. }
        | TExpr::PeriodConst { .. }
        | TExpr::ListRef { .. }
        | TExpr::TimeRef { .. }
        | TExpr::Word { .. } => {}
    }
}

fn walk_call(
    func: FuncId,
    args: &[TExpr],
    path: Path,
    visit: &mut dyn FnMut(LineItemId, Span, Path, bool),
) {
    let shifted = |reach| path.shifted(reach);
    match (kind_of(func), args) {
        (Kind::Cellwise, _) => {
            for arg in args {
                walk(arg, path, visit);
            }
        }
        (Kind::Previous, [x]) => walk(x, shifted(Reach::Backward), visit),
        (kind @ (Kind::Lag | Kind::Offset), [x, count, default]) => {
            let backward = literal_steps(count).is_some_and(|steps| match kind {
                Kind::Lag => steps >= 1,
                _ => steps <= -1,
            });
            walk(
                x,
                shifted(if backward {
                    Reach::Backward
                } else {
                    Reach::Other
                }),
                visit,
            );
            walk(count, path, visit);
            walk(default, path, visit);
        }
        (Kind::Running, [x]) => walk(x, shifted(Reach::Causal), visit),
        _ => {
            for arg in args {
                walk(arg, shifted(Reach::Other), visit);
            }
        }
    }
}

/// The lists that `expr` names or produces items of.
fn lists_in(expr: &TExpr, lists: &mut BTreeSet<ListId>) {
    if let Some(ValueType::Item(list)) = expr.ty() {
        lists.insert(list);
    }
    match expr {
        TExpr::LineItem { modifiers, .. } => {
            for modifier in modifiers {
                if let TModifier::Select(SelectTarget::Item { list, .. }) = modifier {
                    lists.insert(*list);
                }
            }
        }
        TExpr::ListItemConst { list, .. } | TExpr::ListRef { list, .. } => {
            lists.insert(*list);
        }
        TExpr::Unary { expr, .. } => lists_in(expr, lists),
        TExpr::Binary { lhs, rhs, .. } => {
            lists_in(lhs, lists);
            lists_in(rhs, lists);
        }
        TExpr::If {
            cond, then, els, ..
        } => {
            for part in [cond, then, els] {
                lists_in(part, lists);
            }
        }
        TExpr::Call { args, .. } => {
            for arg in args {
                lists_in(arg, lists);
            }
        }
        TExpr::Const { .. }
        | TExpr::VersionConst { .. }
        | TExpr::PeriodConst { .. }
        | TExpr::TimeRef { .. }
        | TExpr::Word { .. } => {}
    }
}

/// A line item that another one reads.
#[derive(Debug)]
struct Edge {
    source: LineItemId,
    reads: Reads,
    /// How the source lines up with the reader, if it does cell by cell.
    alignment: Option<Alignment>,
}

/// What the formula of line item `id` reads, with one edge for each line item. A line item is
/// also read for the sake of another where reading it takes its summary to a coarser level: the
/// parts of a ratio summary are then needed too.
fn edges_of(
    structure: &Structure,
    formulas: &HashMap<LineItemId, Formula>,
    id: LineItemId,
) -> Result<Vec<Edge>, EngineError> {
    let (Some(formula), Some(line_item)) = (formulas.get(&id), structure.line_item(id)) else {
        return Ok(Vec::new());
    };
    let mut found: BTreeMap<LineItemId, Reads> = BTreeMap::new();
    let mut note = |source: LineItemId, reads: Reads| {
        found
            .entry(source)
            .and_modify(|known| known.merge(reads))
            .or_insert(reads);
    };
    let root = Path {
        pointwise: true,
        reach: Reach::Same,
    };
    walk(&formula.expr, root, &mut |source, _, path, modified| {
        note(source, Reads::of(path, modified));
    });

    let summarised_by_formula = line_item.summary == SummaryMethod::Formula
        || line_item.time_summary == Some(SummaryMethod::Formula);
    let mut edges = Vec::new();
    let mut parts = Vec::new();
    for (source, reads) in &found {
        let Some(read) = structure.line_item(*source) else {
            continue;
        };
        let layout = structure.layout(read)?;
        let shape = structure.shape_of(&layout)?;
        let alignment = Alignment::between(
            structure,
            (&layout, &shape),
            (&formula.layout, &formula.shape),
        );
        if (alignment.is_none() || reads.modified || summarised_by_formula)
            && let Ok(Some((numerator, denominator))) = ratio_parts(read)
        {
            parts.extend([numerator, denominator]);
        }
        edges.push(Edge {
            source: *source,
            reads: *reads,
            alignment,
        });
    }
    let part_reads = Reads {
        pointwise: false,
        reach: Reach::Other,
        modified: true,
    };
    for part in parts {
        match edges.iter_mut().find(|edge| edge.source == part) {
            Some(edge) => {
                edge.reads.merge(part_reads);
            }
            None => edges.push(Edge {
                source: part,
                reads: part_reads,
                alignment: None,
            }),
        }
    }
    edges.sort_by_key(|edge| edge.source);
    Ok(edges)
}

/// The lists that the cells of line item `id` can depend on.
fn footprint(
    structure: &Structure,
    formulas: &HashMap<LineItemId, Formula>,
    id: LineItemId,
    edges: &[Edge],
) -> Result<Vec<ListId>, EngineError> {
    let mut lists = BTreeSet::new();
    let mut add_line_item = |line_item: &LineItem| -> Result<(), EngineError> {
        for axis in &structure.layout(line_item)?.axes {
            match axis {
                Axis::List(list) | Axis::ListTop(list) => {
                    lists.insert(*list);
                }
                Axis::Subset(subset) => {
                    lists.extend(structure.subset(*subset).map(|subset| subset.list));
                }
                Axis::Time { .. } | Axis::Versions => {}
            }
        }
        if let Format::List { list } = line_item.format {
            lists.insert(list);
        }
        Ok(())
    };
    if let Some(line_item) = structure.line_item(id) {
        add_line_item(line_item)?;
    }
    for edge in edges {
        if let Some(line_item) = structure.line_item(edge.source) {
            add_line_item(line_item)?;
        }
    }
    if let Some(formula) = formulas.get(&id) {
        lists_in(&formula.expr, &mut lists);
    }
    lists.remove(&ListId::VERSIONS);
    Ok(lists.into_iter().collect())
}

impl Alignment {
    /// How `source` lines up with `target`, or `None` when a cell of the source can reach cells
    /// of the target other than those with the same coordinates and, before a switchover, those
    /// of the versions that show the actual version: a dimension of the source that the target
    /// lacks, or a different one, or Versions axes that span other versions.
    fn between(
        structure: &Structure,
        (source_layout, source): (&Layout, &Shape),
        (target_layout, target): (&Layout, &Shape),
    ) -> Option<Alignment> {
        let mut matched = Vec::with_capacity(source.axes.len());
        for (axis, &len) in source.axes.iter().zip(&source.lens) {
            let position = target.axis_pos(axis)?;
            if target.lens[position] != len || matched.contains(&position) {
                return None;
            }
            matched.push(position);
        }
        let switchover = match source.axis_pos(&Axis::Versions) {
            Some(_) if source_layout.restriction != target_layout.restriction => return None,
            Some(source_versions) => Switchover::of(
                structure,
                (source, source_versions),
                (target_layout, target),
                &matched,
            ),
            None => None,
        };
        let free = (0..target.axes.len())
            .filter(|position| !matched.contains(position))
            .map(|position| {
                (
                    position,
                    target.strides[position],
                    target.lens[position] as usize,
                )
            })
            .collect();
        Some(Alignment {
            source: source.clone(),
            target: target.clone(),
            matched,
            free,
            switchover,
        })
    }

    /// The cells of the target that read the cells `cells` of the source, or `None` when they
    /// are so many that the target is better calculated whole.
    pub(crate) fn project(&self, cells: &[usize]) -> Option<Vec<usize>> {
        let size = self.target.size();
        if size == 0 {
            return Some(Vec::new());
        }
        let fanout: usize = self.free.iter().map(|&(_, _, len)| len).product();
        if cells.len().saturating_mul(fanout).saturating_mul(2) >= size {
            return None;
        }
        let mut reading = Vec::with_capacity(cells.len() * fanout);
        for &cell in cells {
            let coords: Vec<usize> = self
                .source
                .strides
                .iter()
                .zip(&self.source.lens)
                .map(|(&stride, &len)| cell / stride % len as usize)
                .collect();
            let first: usize = coords
                .iter()
                .zip(&self.matched)
                .map(|(&coord, &position)| coord * self.target.strides[position])
                .sum();
            self.repeat(first, None, &mut reading);
            if let Some(switchover) = &self.switchover
                && coords[switchover.source_versions] == switchover.actual
            {
                self.show_actual(switchover, &coords, first, &mut reading);
            }
            if reading.len().saturating_mul(2) >= size {
                return None;
            }
        }
        Some(reading)
    }

    /// Adds the cells of the target that repeat the cell `first` over the axes the source lacks,
    /// except the axis `fixed`.
    fn repeat(&self, first: usize, fixed: Option<usize>, out: &mut Vec<usize>) {
        let start = out.len();
        out.push(first);
        for &(position, stride, len) in &self.free {
            if fixed == Some(position) {
                continue;
            }
            let have = out.len() - start;
            for step in 1..len {
                for at in 0..have {
                    let moved = out[start + at] + step * stride;
                    out.push(moved);
                }
            }
        }
    }

    /// Adds the cells of the other versions that show the actual version's cell at `coords`,
    /// which is read by the target cell `first`.
    fn show_actual(
        &self,
        switchover: &Switchover,
        coords: &[usize],
        first: usize,
        out: &mut Vec<usize>,
    ) {
        let stride = self.target.strides[switchover.target_versions];
        let time_stride = self.target.strides[switchover.target_time];
        for (version, &periods) in switchover.cutoff.iter().enumerate() {
            let periods = periods as usize;
            if version == switchover.actual || periods == 0 {
                continue;
            }
            let there = first - switchover.actual * stride + version * stride;
            match switchover.source_time {
                Some(time) if coords[time] < periods => self.repeat(there, None, out),
                Some(_) => {}
                None => {
                    for period in 0..periods {
                        let at = there + period * time_stride;
                        self.repeat(at, Some(switchover.target_time), out);
                    }
                }
            }
        }
    }
}

impl Switchover {
    /// The periods of each version of `target` that show the actual version, if any, for a
    /// source whose Versions axis is the axis `source_versions` of `source` and whose axes
    /// are those `matched` of the target.
    fn of(
        structure: &Structure,
        (source, source_versions): (&Shape, usize),
        (target_layout, target): (&Layout, &Shape),
        matched: &[usize],
    ) -> Option<Switchover> {
        let target_time = target.time_pos()?;
        let target_versions = matched[source_versions];
        let Axis::Time { level, range } = target.axes[target_time] else {
            return None;
        };
        let keys = structure
            .axis_keys(&Axis::Versions, target_layout.restriction.as_deref())
            .ok()?;
        let cutoff = cutoffs(structure, level, range, &keys).ok()?;
        let actual = structure
            .versions()
            .iter()
            .find(|version| version.is_actual)
            .and_then(|version| {
                keys.iter()
                    .position(|key| *key == Some(version.id.0.as_u128()))
            })?;
        let source_time = source.time_pos();
        cutoff
            .iter()
            .any(|&periods| periods > 0)
            .then_some(Switchover {
                source_versions,
                target_versions,
                target_time,
                source_time,
                actual,
                cutoff,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::TimeLevel;

    fn shape(axes: &[(Axis, u32)]) -> Shape {
        Shape::new(
            axes.iter().map(|(axis, _)| axis.clone()).collect(),
            axes.iter().map(|(_, len)| *len).collect(),
        )
    }

    fn alignment(source: &Shape, target: &Shape) -> Alignment {
        let layout = Layout {
            axes: Vec::new(),
            restriction: None,
        };
        let structure = Structure::new(crate::calendar::Calendar {
            fiscal_year_start_month: 1,
            first_year: 2026,
            years: 1,
            current_month: None,
        });
        Alignment::between(&structure, (&layout, source), (&layout, target)).unwrap()
    }

    #[test]
    fn reaches_combine_into_the_earliest_that_is_certain() {
        assert_eq!(Reach::Same.then(Reach::Backward), Reach::Backward);
        assert_eq!(Reach::Backward.then(Reach::Causal), Reach::Backward);
        assert_eq!(Reach::Causal.then(Reach::Same), Reach::Causal);
        assert_eq!(Reach::Backward.then(Reach::Other), Reach::Other);
        assert_eq!(Reach::Same.then(Reach::Same), Reach::Same);
    }

    #[test]
    fn a_source_cell_projects_onto_the_cells_that_repeat_it() {
        let list = ListId::new();
        let time = Axis::Time {
            level: TimeLevel::Month,
            range: None,
        };
        let source = shape(&[(time.clone(), 12)]);
        let target = shape(&[(Axis::List(list), 5), (time, 12)]);

        let aligned = alignment(&source, &target);

        let mut cells = aligned.project(&[3]).unwrap();
        cells.sort_unstable();
        assert_eq!(cells, vec![3, 15, 27, 39, 51]);
        assert_eq!(aligned.project(&[0, 1, 2, 3, 4, 5]), None);
    }

    #[test]
    fn axes_in_another_order_are_matched_by_dimension() {
        let (first, second) = (ListId::new(), ListId::new());
        let source = shape(&[(Axis::List(first), 3), (Axis::List(second), 4)]);
        let target = shape(&[(Axis::List(second), 4), (Axis::List(first), 3)]);

        let aligned = alignment(&source, &target);

        // Source cell (1, 2) is source cell 6, and target cell (2, 1) is target cell 7.
        assert_eq!(aligned.project(&[6]), Some(vec![7]));
    }
}
