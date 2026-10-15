//! Ordering the calculated line items: their strongly connected components, which circular
//! references are allowed and in what order to calculate them, and the layers of line items
//! that can be calculated at the same time.

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::error::FormulaError;
use crate::formula::Span;
use crate::ids::LineItemId;
use crate::shape::Axis;
use crate::structure::Structure;

use super::{Component, Edge, Formula, Path, Reach, walk};

const CYCLE: &str = "formula.cycle";

/// The line items that compile, with what each reads, ready to be ordered.
pub(super) struct Analysis<'a> {
    structure: &'a Structure,
    formulas: &'a HashMap<LineItemId, Formula>,
    ids: &'a [LineItemId],
    index: HashMap<LineItemId, usize>,
    edges: &'a [Vec<Edge>],
}

/// A circular reference: the line items on it, in the order each reads the next and the last
/// the first, and whether it goes back in time but is not allowed to.
pub(super) struct Cycle {
    path: Vec<usize>,
    through_time: bool,
}

impl<'a> Analysis<'a> {
    pub(super) fn new(
        structure: &'a Structure,
        formulas: &'a HashMap<LineItemId, Formula>,
        ids: &'a [LineItemId],
        edges: &'a [Vec<Edge>],
    ) -> Analysis<'a> {
        Analysis {
            structure,
            formulas,
            ids,
            index: ids.iter().enumerate().map(|(at, id)| (*id, at)).collect(),
            edges,
        }
    }

    /// The line items that `node` reads and that have formulas, with how it reads each.
    fn reads(&self, node: usize) -> impl Iterator<Item = (usize, &Edge)> + '_ {
        self.edges[node]
            .iter()
            .filter_map(|edge| self.index.get(&edge.source).map(|&source| (source, edge)))
    }

    /// The strongly connected components, each after every component that it reads.
    pub(super) fn components(&self) -> Vec<Vec<usize>> {
        let deps: Vec<Vec<usize>> = (0..self.ids.len())
            .map(|node| self.reads(node).map(|(source, _)| source).collect())
            .collect();
        strongly_connected(&deps)
    }

    /// Whether the component reads itself: it has several line items, or one that reads itself.
    pub(super) fn is_cyclic(&self, members: &[usize]) -> bool {
        members.len() > 1
            || self
                .reads(members[0])
                .any(|(source, _)| source == members[0])
    }

    /// The order to calculate the members of a cycle in within one period, or the reason the
    /// cycle is not allowed.
    ///
    /// A cycle is allowed when the line items it passes through read each other in the same
    /// period only along a chain, and close the circle only by reading an earlier period of the
    /// line item before them. They must all have the same Time dimension, since they are
    /// calculated one period after another.
    pub(super) fn order_cycle(&self, members: &[usize]) -> Result<Vec<usize>, Cycle> {
        let inside: HashSet<usize> = members.iter().copied().collect();
        let mut waiting: HashMap<usize, usize> = HashMap::new();
        let mut readers: HashMap<usize, Vec<usize>> = HashMap::new();
        for &member in members {
            waiting.insert(member, 0);
        }
        for &member in members {
            for (source, edge) in self.reads(member) {
                if inside.contains(&source) && edge.reads.reach != Reach::Backward {
                    *waiting.entry(member).or_default() += 1;
                    readers.entry(source).or_default().push(member);
                }
            }
        }
        let mut ready: BTreeSet<usize> = members
            .iter()
            .copied()
            .filter(|member| waiting[member] == 0)
            .collect();
        let mut order = Vec::with_capacity(members.len());
        while let Some(member) = ready.pop_first() {
            order.push(member);
            for &reader in readers.get(&member).map_or(&[][..], Vec::as_slice) {
                let count = waiting.entry(reader).or_default();
                *count -= 1;
                if *count == 0 {
                    ready.insert(reader);
                }
            }
        }
        let placed: HashSet<usize> = order.iter().copied().collect();
        if order.len() < members.len() {
            let stuck: Vec<usize> = members
                .iter()
                .copied()
                .filter(|member| !placed.contains(member))
                .collect();
            let path = self.find_cycle(&stuck, |node| {
                self.reads(node)
                    .filter(|(source, edge)| {
                        edge.reads.reach != Reach::Backward
                            && inside.contains(source)
                            && !placed.contains(source)
                    })
                    .map(|(source, _)| source)
                    .collect()
            });
            return Err(Cycle {
                path,
                through_time: false,
            });
        }
        if !self.share_time_axis(members) || !self.only_reads_the_present(&inside) {
            let path = self.find_cycle(members, |node| {
                self.reads(node)
                    .filter(|(source, _)| inside.contains(source))
                    .map(|(source, _)| source)
                    .collect()
            });
            return Err(Cycle {
                path,
                through_time: true,
            });
        }
        Ok(order)
    }

    /// Whether every member has the same Time axis.
    fn share_time_axis(&self, members: &[usize]) -> bool {
        let axes: Vec<Option<&Axis>> = members
            .iter()
            .map(|&member| {
                let shape = &self.formulas[&self.ids[member]].shape;
                shape.time_pos().map(|position| &shape.axes[position])
            })
            .collect();
        axes[0].is_some() && axes.iter().all(|axis| *axis == axes[0])
    }

    /// Whether, within the cycle, only a backward shift reads an earlier period and nothing
    /// reads a later one or a period that depends on the data.
    fn only_reads_the_present(&self, inside: &HashSet<usize>) -> bool {
        inside.iter().all(|&member| {
            self.reads(member)
                .all(|(source, edge)| !inside.contains(&source) || edge.reads.reach != Reach::Other)
        })
    }

    /// A circular path among `nodes` along the reads `successors` gives, starting from the
    /// line item that comes first on it.
    fn find_cycle(&self, nodes: &[usize], successors: impl Fn(usize) -> Vec<usize>) -> Vec<usize> {
        let mut state: HashMap<usize, u8> = HashMap::new();
        for &start in nodes {
            if state.contains_key(&start) {
                continue;
            }
            state.insert(start, 1);
            let mut path = vec![start];
            let mut next = vec![successors(start).into_iter()];
            while let Some(reads) = next.last_mut() {
                match reads.next() {
                    Some(node) => match state.get(&node) {
                        None => {
                            state.insert(node, 1);
                            path.push(node);
                            next.push(successors(node).into_iter());
                        }
                        Some(1) => {
                            let from = path.iter().position(|&on| on == node).unwrap_or(0);
                            let mut cycle = path[from..].to_vec();
                            let first = cycle
                                .iter()
                                .enumerate()
                                .min_by_key(|(_, node)| **node)
                                .map_or(0, |(at, _)| at);
                            cycle.rotate_left(first);
                            return cycle;
                        }
                        Some(_) => {}
                    },
                    None => {
                        if let Some(done) = path.pop() {
                            state.insert(done, 2);
                        }
                        next.pop();
                    }
                }
            }
        }
        nodes.to_vec()
    }

    /// The error of every member of a circular reference that is not allowed, each located at
    /// the first reference in its formula to a member.
    pub(super) fn cycle_errors(
        &self,
        members: &[usize],
        cycle: &Cycle,
    ) -> Vec<(LineItemId, FormulaError)> {
        let message = self.cycle_message(cycle);
        let ids: HashSet<LineItemId> = members.iter().map(|&member| self.ids[member]).collect();
        members
            .iter()
            .map(|&member| {
                let id = self.ids[member];
                let mut first: Option<Span> = None;
                walk(
                    &self.formulas[&id].expr,
                    Path {
                        pointwise: true,
                        reach: Reach::Same,
                    },
                    &mut |source, span, _, _| {
                        if ids.contains(&source)
                            && first.is_none_or(|known| span.start < known.start)
                        {
                            first = Some(span);
                        }
                    },
                );
                let span = first.unwrap_or(Span { start: 0, end: 0 });
                let error = FormulaError {
                    code: CYCLE,
                    message: message.clone(),
                    start: span.start,
                    end: span.end,
                    suggestion: None,
                };
                (id, error)
            })
            .collect()
    }

    fn cycle_message(&self, cycle: &Cycle) -> String {
        let names: Vec<String> = cycle
            .path
            .iter()
            .chain(cycle.path.first())
            .map(|&node| self.name_of(self.ids[node], &cycle.path))
            .collect();
        let mut message = format!("Circular reference: {}", names.join(" → "));
        if cycle.through_time {
            message.push_str(
                ". A circular reference is allowed only when it goes back in time with PREVIOUS, LAG or OFFSET by a fixed number of periods, and every line item in it has the same Time dimension.",
            );
        }
        message
    }

    /// The name of a line item in a message, with its module when another line item on the
    /// path has the same name.
    fn name_of(&self, id: LineItemId, path: &[usize]) -> String {
        let Some(line_item) = self.structure.line_item(id) else {
            return "?".to_string();
        };
        let shared = path
            .iter()
            .filter_map(|&node| self.structure.line_item(self.ids[node]))
            .filter(|other| other.name == line_item.name)
            .count()
            > 1;
        match self.structure.module(line_item.module) {
            Some(module) if shared => format!("{}.{}", module.name, line_item.name),
            _ => line_item.name.clone(),
        }
    }

    /// The valid components arranged in layers, each component in the layer after the last of
    /// those it reads. Line items of a circular reference that is not allowed hold no one up.
    pub(super) fn layers(
        &self,
        valid: &[(Vec<usize>, bool)],
        broken: &HashSet<usize>,
    ) -> Vec<Vec<Component>> {
        let mut component_of: HashMap<usize, usize> = HashMap::new();
        for (at, (members, _)) in valid.iter().enumerate() {
            for &member in members {
                component_of.insert(member, at);
            }
        }
        let mut layer_of = vec![0usize; valid.len()];
        let mut layers: Vec<Vec<Component>> = Vec::new();
        for (at, (members, cyclic)) in valid.iter().enumerate() {
            let layer = members
                .iter()
                .flat_map(|&member| self.reads(member))
                .filter(|(source, _)| !broken.contains(source))
                .filter_map(|(source, _)| component_of.get(&source))
                .filter(|&&other| other != at)
                .map(|&other| layer_of[other] + 1)
                .max()
                .unwrap_or(0);
            layer_of[at] = layer;
            if layers.len() <= layer {
                layers.resize_with(layer + 1, Vec::new);
            }
            layers[layer].push(Component {
                members: members.iter().map(|&member| self.ids[member]).collect(),
                cyclic: *cyclic,
            });
        }
        for layer in &mut layers {
            layer.sort_by_key(|component| component.members[0]);
        }
        layers
    }
}

/// The strongly connected components of a graph given by the nodes each node points at, in an
/// order in which a component comes after every component its nodes point at.
fn strongly_connected(points_at: &[Vec<usize>]) -> Vec<Vec<usize>> {
    const UNSEEN: usize = usize::MAX;
    let count = points_at.len();
    let mut number = vec![UNSEEN; count];
    let mut lowest = vec![0; count];
    let mut on_stack = vec![false; count];
    let mut stack = Vec::new();
    let mut next_number = 0;
    let mut components = Vec::new();
    for root in 0..count {
        if number[root] != UNSEEN {
            continue;
        }
        number[root] = next_number;
        lowest[root] = next_number;
        next_number += 1;
        stack.push(root);
        on_stack[root] = true;
        let mut work = vec![(root, 0usize)];
        while let Some(&(node, at)) = work.last() {
            if let Some(&target) = points_at[node].get(at) {
                if let Some(top) = work.last_mut() {
                    top.1 += 1;
                }
                if number[target] == UNSEEN {
                    number[target] = next_number;
                    lowest[target] = next_number;
                    next_number += 1;
                    stack.push(target);
                    on_stack[target] = true;
                    work.push((target, 0));
                } else if on_stack[target] {
                    lowest[node] = lowest[node].min(number[target]);
                }
                continue;
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                lowest[parent] = lowest[parent].min(lowest[node]);
            }
            if lowest[node] == number[node] {
                let mut component = Vec::new();
                while let Some(member) = stack.pop() {
                    on_stack[member] = false;
                    component.push(member);
                    if member == node {
                        break;
                    }
                }
                components.push(component);
            }
        }
    }
    components
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn components_come_after_the_components_they_point_at() {
        let points_at = vec![vec![1], vec![2], vec![1], vec![0, 3], vec![]];
        let components = strongly_connected(&points_at);

        let sorted: Vec<Vec<usize>> = components
            .iter()
            .map(|component| {
                let mut component = component.clone();
                component.sort_unstable();
                component
            })
            .collect();
        assert_eq!(sorted, vec![vec![1, 2], vec![0], vec![3], vec![4]]);
    }

    #[test]
    fn a_long_chain_does_not_exhaust_the_stack() {
        let points_at: Vec<Vec<usize>> = (0..200_000)
            .map(|node| {
                if node == 0 {
                    Vec::new()
                } else {
                    vec![node - 1]
                }
            })
            .collect();

        let components = strongly_connected(&points_at);

        assert_eq!(components.len(), 200_000);
        assert_eq!(components[0], vec![0]);
    }
}
