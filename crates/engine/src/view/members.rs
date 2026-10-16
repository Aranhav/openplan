use super::{
    Cx, Header, Member, MemberRef, PageMember, PageSelection, PassingRows, Place, ViewDim,
};
use crate::calendar::{Calendar, TimeLevel};
use crate::error::EngineError;
use crate::ids::{ItemId, LineItemId, ListId, VersionId};
use crate::structure::{List, Structure};
use crate::summary::ancestors;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Which member of a dimension a node is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Id {
    /// The total of a list.
    Top,
    /// An item of a list or subset, at any level.
    Item(ItemId),
    Period(TimeLevel, u32),
    Version(VersionId),
    LineItem(LineItemId),
}

/// A member of a dimension in the tree a view shows.
#[derive(Clone, Copy, Debug)]
pub(super) struct Node {
    pub(super) id: Id,
    depth: u8,
    pub(super) summary: bool,
    children: bool,
    /// The summary this member is part of.
    parent: Option<usize>,
}

impl Node {
    pub(super) fn leaf(id: Id) -> Node {
        Node {
            id,
            depth: 0,
            summary: false,
            children: false,
            parent: None,
        }
    }

    pub(super) fn total(id: Id) -> Node {
        Node {
            summary: true,
            ..Node::leaf(id)
        }
    }
}

/// How the members of one dimension are named.
pub(super) struct Namer<'a> {
    structure: &'a Structure,
    /// The lists whose items the dimension holds: a list and those above it, or a subset's list.
    lists: Vec<&'a List>,
    top: Option<&'a str>,
    calendar: Option<Calendar>,
}

impl Namer<'_> {
    fn key(&self, id: Id) -> String {
        match id {
            Id::Top => "top".to_string(),
            Id::Item(item) => item.0.to_string(),
            Id::Period(level, period) => self.period_label(level, period),
            Id::Version(version) => version.0.to_string(),
            Id::LineItem(line_item) => line_item.0.to_string(),
        }
    }

    fn label(&self, id: Id) -> String {
        match id {
            Id::Top => self.top.unwrap_or_default().to_string(),
            Id::Item(item) => self
                .lists
                .iter()
                .find_map(|list| list.idx(item).map(|idx| list.item(idx).name.clone()))
                .unwrap_or_default(),
            Id::Period(level, period) => self.period_label(level, period),
            Id::Version(version) => self
                .structure
                .version(version)
                .map(|version| version.name.clone())
                .unwrap_or_default(),
            Id::LineItem(line_item) => self
                .structure
                .line_item(line_item)
                .map(|line_item| line_item.name.clone())
                .unwrap_or_default(),
        }
    }

    fn period_label(&self, level: TimeLevel, period: u32) -> String {
        self.calendar
            .map(|calendar| calendar.label(level, period))
            .unwrap_or_default()
    }

    pub(super) fn member(&self, node: &Node, collapsed: bool) -> Member {
        Member {
            key: self.key(node.id),
            label: self.label(node.id),
            depth: node.depth,
            is_summary: node.summary,
            has_children: node.children,
            collapsed,
        }
    }
}

/// The members of a dimension that a row or column shows.
pub(super) struct Shown<'a> {
    pub(super) dim: ViewDim,
    /// Every member of the dimension.
    nodes: Vec<Node>,
    /// The positions among `nodes` of the members shown, in order.
    shown: Vec<usize>,
    collapsed: HashSet<Id>,
    namer: Namer<'a>,
}

impl Shown<'_> {
    pub(super) fn node(&self, at: usize) -> Node {
        self.nodes[self.shown[at]]
    }

    fn member(&self, at: usize) -> Member {
        let node = self.node(at);
        self.namer
            .member(&node, node.children && self.collapsed.contains(&node.id))
    }
}

/// The rows or the columns of a view: the product of the members of their dimensions.
pub(super) struct Side<'a> {
    pub(super) dims: Vec<Shown<'a>>,
    /// The rows that pass the filters, as positions among all of them.
    pub(super) passing: Option<PassingRows>,
}

impl Side<'_> {
    pub(super) fn lens(&self) -> Vec<usize> {
        self.dims.iter().map(|dim| dim.shown.len()).collect()
    }

    /// How many rows or columns the dimensions make before filters, at most `usize::MAX`.
    pub(super) fn total(&self) -> usize {
        self.dims
            .iter()
            .fold(1, |total, dim| total.saturating_mul(dim.shown.len()))
    }

    pub(super) fn count(&self) -> usize {
        self.passing
            .as_ref()
            .map_or_else(|| self.total(), |passing| passing.len())
    }

    /// The positions among the shown members of each dimension of the row or column `at`.
    pub(super) fn tuple(&self, at: usize) -> Vec<usize> {
        let linear = self.passing.as_ref().map_or(at, |passing| passing[at]);
        split(linear, &self.lens())
    }

    pub(super) fn header(&self, tuple: &[usize]) -> Header {
        Header {
            members: self
                .dims
                .iter()
                .zip(tuple)
                .map(|(dim, &at)| dim.member(at))
                .collect(),
        }
    }
}

/// The rows, columns and pages of a query, to find the member of any dimension for a cell.
pub(super) struct Frame<'a> {
    pub(super) places: &'a [Place],
    pub(super) rows: &'a Side<'a>,
    pub(super) columns: &'a Side<'a>,
    pub(super) pages: &'a [Node],
}

impl Frame<'_> {
    /// The member of dimension `dim` of the module in the cell at a row and a column, which hold
    /// the positions among the shown members of their dimensions.
    pub(super) fn node(&self, dim: usize, row: &[usize], column: &[usize]) -> Node {
        match self.places[dim] {
            Place::Row(at) => self.rows.dims[at].node(row[at]),
            Place::Column(at) => self.columns.dims[at].node(column[at]),
            Place::Page(at) => self.pages[at],
        }
    }
}

impl<'a> Cx<'a> {
    /// The members a dimension has, with the summaries above them when asked for.
    pub(super) fn nodes(&self, dim: &ViewDim, summaries: bool) -> Result<Vec<Node>, EngineError> {
        Ok(match dim {
            ViewDim::LineItems => self
                .line_items
                .iter()
                .map(|id| Node::leaf(Id::LineItem(*id)))
                .collect(),
            ViewDim::List { list } => self.list_nodes(*list, summaries)?,
            ViewDim::Subset { subset } => self
                .subset(*subset)?
                .items
                .iter()
                .map(|item| Node::leaf(Id::Item(*item)))
                .collect(),
            ViewDim::Time => self.time_nodes(summaries),
            ViewDim::Versions => self
                .structure
                .versions()
                .iter()
                .map(|version| Node::leaf(Id::Version(version.id)))
                .collect(),
        })
    }

    /// The items of a list. With summaries they are a tree, a parent before the items below it,
    /// under the total of the list if it has one; without, the items in list order.
    fn list_nodes(&self, id: ListId, summaries: bool) -> Result<Vec<Node>, EngineError> {
        let list = self.list(id)?;
        if !summaries {
            return Ok(list
                .items()
                .map(|(_, item)| Node::leaf(Id::Item(item.id)))
                .collect());
        }
        // The lists from the top of the hierarchy down to this one, and for each the items below
        // every item of the list above.
        let mut levels = ancestors(self.structure, id)?
            .into_iter()
            .map(|level| self.list(level))
            .collect::<Result<Vec<_>, _>>()?;
        levels.reverse();
        let children: Vec<HashMap<ItemId, Vec<ItemId>>> = levels
            .iter()
            .map(|level| {
                let mut below: HashMap<ItemId, Vec<ItemId>> = HashMap::new();
                for (_, item) in level.items() {
                    if let Some(parent) = item.parent {
                        below.entry(parent).or_default().push(item.id);
                    }
                }
                below
            })
            .collect();

        let roots = levels[0].items().map(|(_, item)| item.id);
        let mut nodes = Vec::new();
        let (mut parent, mut depth) = (None, 0);
        if list.top_level_name.is_some() {
            nodes.push(Node {
                children: levels[0].items().next().is_some(),
                ..Node::total(Id::Top)
            });
            (parent, depth) = (Some(0), 1);
        }
        for root in roots {
            emit_item(&mut nodes, &children, 0, root, depth, parent);
        }
        Ok(nodes)
    }

    /// The periods of the module's Time dimension. With summaries the periods above them follow
    /// the periods they add up, the total last.
    fn time_nodes(&self, summaries: bool) -> Vec<Node> {
        let Some(time) = &self.time else {
            return Vec::new();
        };
        if !summaries || time.level == TimeLevel::All {
            return (0..time.calendar.periods(time.level))
                .map(|period| Node::leaf(Id::Period(time.level, period)))
                .collect();
        }
        let mut nodes = Vec::new();
        emit_period(&mut nodes, &time.calendar, time.level, TimeLevel::All, 0);
        nodes
    }

    /// The member of a dimension that a key names.
    fn resolve(&self, dim: &ViewDim, key: &str) -> Result<Id, EngineError> {
        self.require_dim(dim)?;
        let uuid = Uuid::parse_str(key).ok();
        let found = match dim {
            ViewDim::LineItems => uuid
                .map(LineItemId)
                .filter(|id| self.line_items.contains(id))
                .map(Id::LineItem),
            ViewDim::List { list } => {
                if key == "top" {
                    self.list(*list)?
                        .top_level_name
                        .is_some()
                        .then_some(Id::Top)
                } else {
                    let levels = ancestors(self.structure, *list)?;
                    uuid.map(ItemId)
                        .filter(|item| {
                            levels.iter().any(|level| {
                                self.structure
                                    .list(*level)
                                    .is_some_and(|level| level.idx(*item).is_some())
                            })
                        })
                        .map(Id::Item)
                }
            }
            ViewDim::Subset { subset } => {
                let subset = self.subset(*subset)?;
                uuid.map(ItemId)
                    .filter(|item| subset.items.contains(item))
                    .map(Id::Item)
            }
            ViewDim::Time => self.time.as_ref().and_then(|time| {
                time.calendar
                    .parse_label(key)
                    .filter(|(level, _)| *level >= time.level)
                    .map(|(level, period)| Id::Period(level, period))
            }),
            ViewDim::Versions => uuid
                .map(VersionId)
                .filter(|id| self.structure.version(*id).is_some())
                .map(Id::Version),
        };
        found.ok_or_else(|| {
            EngineError::invalid(format!(
                "'{key}' is not a member of '{}'.",
                self.dim_name(dim)
            ))
        })
    }

    /// The members that references name in each dimension of the module.
    pub(super) fn member_sets(&self, refs: &[MemberRef]) -> Result<Vec<HashSet<Id>>, EngineError> {
        let mut sets = vec![HashSet::new(); self.dims.len()];
        for member in refs {
            let id = self.resolve(&member.dim, &member.key)?;
            sets[self.require_dim(&member.dim)?].insert(id);
        }
        Ok(sets)
    }

    pub(super) fn namer(&self, dim: &ViewDim) -> Result<Namer<'a>, EngineError> {
        let mut namer = Namer {
            structure: self.structure,
            lists: Vec::new(),
            top: None,
            calendar: self.time.map(|time| time.calendar),
        };
        match dim {
            ViewDim::List { list } => {
                namer.lists = ancestors(self.structure, *list)?
                    .into_iter()
                    .map(|level| self.list(level))
                    .collect::<Result<_, _>>()?;
                namer.top = self.list(*list)?.top_level_name.as_deref();
            }
            ViewDim::Subset { subset } => {
                namer.lists = vec![self.list(self.subset(*subset)?.list)?];
            }
            ViewDim::LineItems | ViewDim::Time | ViewDim::Versions => {}
        }
        Ok(namer)
    }

    /// The members of a dimension that a row or column shows.
    fn shown(
        &self,
        dim: &ViewDim,
        summaries: bool,
        collapsed: &HashSet<Id>,
        hidden: &HashSet<Id>,
    ) -> Result<Shown<'a>, EngineError> {
        let nodes = self.nodes(dim, summaries)?;
        let collapsed = if summaries {
            collapsed.clone()
        } else {
            HashSet::new()
        };
        let shown = (0..nodes.len())
            .filter(|&at| {
                !hidden.contains(&nodes[at].id) && !under_collapsed(&nodes, at, &collapsed)
            })
            .collect();
        Ok(Shown {
            dim: dim.clone(),
            nodes,
            shown,
            collapsed,
            namer: self.namer(dim)?,
        })
    }

    pub(super) fn side(
        &self,
        dims: &[ViewDim],
        summaries: bool,
        collapsed: &[HashSet<Id>],
        hidden: &[HashSet<Id>],
    ) -> Result<Side<'a>, EngineError> {
        let dims = dims
            .iter()
            .map(|dim| {
                let at = self.require_dim(dim)?;
                self.shown(dim, summaries, &collapsed[at], &hidden[at])
            })
            .collect::<Result<_, _>>()?;
        Ok(Side {
            dims,
            passing: None,
        })
    }

    /// The member a page shows, with the node that stands for it, or `None` for a dimension
    /// without members.
    pub(super) fn page(
        &self,
        selection: &PageSelection,
    ) -> Result<Option<(PageMember, Node)>, EngineError> {
        self.require_dim(&selection.dim)?;
        let id = match &selection.key {
            Some(key) => Some(self.resolve(&selection.dim, key)?),
            None => self.default_member(&selection.dim)?,
        };
        let Some(id) = id else {
            return Ok(None);
        };
        let namer = self.namer(&selection.dim)?;
        Ok(self
            .nodes(&selection.dim, true)?
            .into_iter()
            .find(|node| node.id == id)
            .map(|node| {
                let member = PageMember {
                    dim: selection.dim.clone(),
                    member: namer.member(&node, false),
                };
                (member, node)
            }))
    }

    /// The member a page starts at: the total of a list that has one, else its first item.
    fn default_member(&self, dim: &ViewDim) -> Result<Option<Id>, EngineError> {
        Ok(match dim {
            ViewDim::LineItems => self.line_items.first().copied().map(Id::LineItem),
            ViewDim::List { list } => {
                let list = self.list(*list)?;
                if list.top_level_name.is_some() {
                    Some(Id::Top)
                } else {
                    list.items().next().map(|(_, item)| Id::Item(item.id))
                }
            }
            ViewDim::Subset { subset } => {
                self.subset(*subset)?.items.first().copied().map(Id::Item)
            }
            ViewDim::Time => self.time.map(|time| Id::Period(time.level, 0)),
            ViewDim::Versions => self
                .structure
                .versions()
                .iter()
                .find(|version| version.is_current)
                .map(|version| Id::Version(version.id)),
        })
    }
}

/// Adds an item of a list and the items below it to a tree, a parent before its children.
/// `level` counts down from the top of the hierarchy; `children[level]` holds the items of that
/// level's list below each item of the list above.
fn emit_item(
    nodes: &mut Vec<Node>,
    children: &[HashMap<ItemId, Vec<ItemId>>],
    level: usize,
    item: ItemId,
    depth: u8,
    parent: Option<usize>,
) {
    let below = children
        .get(level + 1)
        .and_then(|below| below.get(&item))
        .filter(|below| !below.is_empty());
    let at = nodes.len();
    nodes.push(Node {
        id: Id::Item(item),
        depth,
        summary: level + 1 < children.len(),
        children: below.is_some(),
        parent,
    });
    for child in below.into_iter().flatten() {
        emit_item(
            nodes,
            children,
            level + 1,
            *child,
            depth.saturating_add(1),
            Some(at),
        );
    }
}

/// The level below `level`.
pub(super) fn finer(level: TimeLevel) -> TimeLevel {
    match level {
        TimeLevel::All => TimeLevel::Year,
        TimeLevel::Year => TimeLevel::HalfYear,
        TimeLevel::HalfYear => TimeLevel::Quarter,
        TimeLevel::Quarter | TimeLevel::Month => TimeLevel::Month,
    }
}

/// Adds a period and the periods it adds up down to `leaf_level` to a tree, the periods
/// before the one they add up. Returns the position of the period.
fn emit_period(
    nodes: &mut Vec<Node>,
    calendar: &Calendar,
    leaf_level: TimeLevel,
    level: TimeLevel,
    period: u32,
) -> usize {
    if level == leaf_level {
        nodes.push(Node::leaf(Id::Period(level, period)));
        return nodes.len() - 1;
    }
    let below = finer(level);
    let per_period = calendar.periods(below) / calendar.periods(level);
    let children: Vec<usize> = (period * per_period..(period + 1) * per_period)
        .map(|child| emit_period(nodes, calendar, leaf_level, below, child))
        .collect();
    let at = nodes.len();
    for child in children {
        nodes[child].parent = Some(at);
    }
    nodes.push(Node {
        depth: level as u8 - leaf_level as u8,
        children: true,
        ..Node::total(Id::Period(level, period))
    });
    at
}

/// Whether a collapsed summary holds the node.
fn under_collapsed(nodes: &[Node], mut at: usize, collapsed: &HashSet<Id>) -> bool {
    if collapsed.is_empty() {
        return false;
    }
    while let Some(parent) = nodes[at].parent {
        if collapsed.contains(&nodes[parent].id) {
            return true;
        }
        at = parent;
    }
    false
}

/// The position along each dimension of the row or column at `linear` among the product of
/// dimensions of lengths `lens`, the last dimension varying fastest.
pub(super) fn split(mut linear: usize, lens: &[usize]) -> Vec<usize> {
    let mut picks = vec![0; lens.len()];
    for (pick, &len) in picks.iter_mut().zip(lens).rev() {
        *pick = linear % len;
        linear /= len;
    }
    picks
}
