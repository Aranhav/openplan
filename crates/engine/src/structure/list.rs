use std::collections::{HashMap, HashSet};

use crate::command::ItemSpec;
use crate::error::EngineError;
use crate::ids::{ItemId, ListId, ModuleId, SubsetId};
use crate::value::Format;

use super::module::{AxisSpec, properties_name};
use super::{
    Structure, Subset, already_exists, check_name, clean_name, ensure_unique, fold, in_use,
    invalid, not_found, same_name,
};

/// An ordered set of items such as products or regions.
///
/// Items keep a dense index for their whole life: deleting one leaves a tombstone so the
/// indices of the others, and therefore every stored cell, stay valid.
#[derive(Clone, Debug)]
pub struct List {
    pub id: ListId,
    pub name: String,
    /// The list one hierarchy level up; every item then has a parent item in that list.
    pub parent: Option<ListId>,
    /// Name of the single total item above all items, if the list has one.
    pub top_level_name: Option<String>,
    /// Items are identified by code and their names may repeat.
    pub numbered: bool,
    /// The items are data that does not travel with the model structure.
    pub production_data: bool,
    pub selective_access: bool,
    items: Vec<Item>,
    index: HashMap<ItemId, u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: ItemId,
    pub code: Option<String>,
    pub name: String,
    pub parent: Option<ItemId>,
    pub deleted: bool,
}

impl List {
    fn new(
        id: ListId,
        name: String,
        parent: Option<ListId>,
        top_level_name: Option<String>,
        numbered: bool,
        production_data: bool,
    ) -> List {
        List {
            id,
            name,
            parent,
            top_level_name,
            numbered,
            production_data,
            selective_access: false,
            items: Vec::new(),
            index: HashMap::new(),
        }
    }

    /// The items that have not been deleted, with their dense index, in order.
    pub fn items(&self) -> impl Iterator<Item = (u32, &Item)> {
        self.items
            .iter()
            .enumerate()
            .filter(|(_, item)| !item.deleted)
            .map(|(idx, item)| (idx as u32, item))
    }

    /// Number of dense indices, tombstones of deleted items included.
    pub fn len_dense(&self) -> u32 {
        self.items.len() as u32
    }

    /// Dense index of a live item.
    pub fn idx(&self, id: ItemId) -> Option<u32> {
        self.index
            .get(&id)
            .copied()
            .filter(|&idx| !self.items[idx as usize].deleted)
    }

    /// The item at a dense index. Panics if `idx >= len_dense()`.
    pub fn item(&self, idx: u32) -> &Item {
        &self.items[idx as usize]
    }

    /// Dense index of the live item with this name, ignoring case, or else this exact code.
    pub fn find(&self, name_or_code: &str) -> Option<u32> {
        find_by(
            name_or_code,
            |name| {
                self.items()
                    .find(|(_, item)| same_name(&item.name, name))
                    .map(|(idx, _)| idx)
            },
            |code| {
                self.items()
                    .find(|(_, item)| item.code.as_deref() == Some(code))
                    .map(|(idx, _)| idx)
            },
        )
    }

    fn was_deleted(&self, id: ItemId) -> bool {
        self.index
            .get(&id)
            .is_some_and(|&idx| self.items[idx as usize].deleted)
    }
}

/// The items of a list by name, ignoring case, and by code, indexed for many lookups in a row.
/// Each lookup gives what [`List::find`] gives, without a scan of the list.
pub struct Lookup<'a> {
    names: HashMap<String, u32>,
    codes: HashMap<&'a str, u32>,
}

impl<'a> Lookup<'a> {
    /// The index of the live items of `list`; the first item of a name or code is the one found.
    pub fn new(list: &'a List) -> Lookup<'a> {
        let mut names = HashMap::new();
        let mut codes = HashMap::new();
        for (idx, item) in list.items() {
            names.entry(fold(&item.name)).or_insert(idx);
            if let Some(code) = &item.code {
                codes.entry(code.as_str()).or_insert(idx);
            }
        }
        Lookup { names, codes }
    }

    /// Dense index of the item that [`List::find`] finds for `name_or_code`.
    pub fn find(&self, name_or_code: &str) -> Option<u32> {
        find_by(
            name_or_code,
            |name| self.names.get(&fold(name)).copied(),
            |code| self.codes.get(code).copied(),
        )
    }
}

/// The rule of [`List::find`], over the two ways of looking an item up: the text is trimmed,
/// the name is tried first, and the code only when no item has the name.
fn find_by(
    name_or_code: &str,
    by_name: impl Fn(&str) -> Option<u32>,
    by_code: impl Fn(&str) -> Option<u32>,
) -> Option<u32> {
    let needle = name_or_code.trim();
    by_name(needle).or_else(|| by_code(needle))
}

/// A validated item to add or update.
struct PlannedItem {
    id: ItemId,
    existing: Option<u32>,
    code: Option<String>,
    name: String,
    parent: Option<ItemId>,
}

impl Structure {
    pub(super) fn create_list(
        &mut self,
        id: ListId,
        name: String,
        parent: Option<ListId>,
        top_level_name: Option<String>,
        numbered: bool,
        production_data: bool,
    ) -> Result<(), EngineError> {
        if id == ListId::VERSIONS {
            return Err(invalid(
                "That list id is reserved for the Versions dimension.",
            ));
        }
        if self.lists.contains_key(&id) {
            return Err(already_exists("list", id.0));
        }
        if self.modules.contains_key(&ModuleId(id.0)) {
            return Err(invalid("A list cannot have the id of a module."));
        }
        let name = check_name("list", &name, self.lists.values().map(|l| l.name.as_str()))?;
        check_not_reserved(&name)?;
        if let Some(parent) = parent {
            if parent == id {
                return Err(invalid("A list cannot be its own parent."));
            }
            if !self.lists.contains_key(&parent) {
                return Err(not_found("list", parent.0));
            }
        }
        let top_level_name = top_level_name
            .map(|name| clean_name("top level", &name))
            .transpose()?;
        self.lists.insert(
            id,
            List::new(id, name, parent, top_level_name, numbered, production_data),
        );
        Ok(())
    }

    pub(super) fn update_list(
        &mut self,
        id: ListId,
        name: Option<String>,
        top_level_name: Option<Option<String>>,
        production_data: Option<bool>,
        selective_access: Option<bool>,
    ) -> Result<(), EngineError> {
        if !self.lists.contains_key(&id) {
            return Err(not_found("list", id.0));
        }
        let name = name
            .map(|name| {
                let name = check_name(
                    "list",
                    &name,
                    self.lists
                        .values()
                        .filter(|list| list.id != id)
                        .map(|list| list.name.as_str()),
                )?;
                check_not_reserved(&name)?;
                Ok::<_, EngineError>(name)
            })
            .transpose()?;
        let top_level_name = top_level_name
            .map(|name| name.map(|name| clean_name("top level", &name)).transpose())
            .transpose()?;
        let properties = ModuleId::for_list_properties(id);
        let properties_rename = match &name {
            Some(name) if self.modules.contains_key(&properties) => {
                let module_name = properties_name(name);
                ensure_unique(
                    "module",
                    &module_name,
                    self.modules
                        .values()
                        .filter(|module| module.id != properties)
                        .map(|module| module.name.as_str()),
                )?;
                Some(module_name)
            }
            _ => None,
        };

        let list = self.list_mut(id)?;
        if let Some(name) = name {
            list.name = name;
        }
        if let Some(top_level_name) = top_level_name {
            list.top_level_name = top_level_name;
        }
        if let Some(production_data) = production_data {
            list.production_data = production_data;
        }
        if let Some(selective_access) = selective_access {
            list.selective_access = selective_access;
        }
        if let (Some(module_name), Some(module)) =
            (properties_rename, self.modules.get_mut(&properties))
        {
            module.name = module_name;
        }
        Ok(())
    }

    pub(super) fn delete_list(&mut self, id: ListId) -> Result<(), EngineError> {
        let list = self.lists.get(&id).ok_or_else(|| not_found("list", id.0))?;
        let properties = ModuleId::for_list_properties(id);
        let axis = AxisSpec::List { list: id };
        let mut users = Vec::new();
        users.extend(
            self.modules
                .values()
                .filter(|module| module.id != properties && module.axes.contains(&axis))
                .map(|module| format!("module '{}'", module.name)),
        );
        users.extend(
            self.subsets
                .values()
                .filter(|subset| subset.list == id)
                .map(|subset| format!("subset '{}'", subset.name)),
        );
        users.extend(
            self.lists
                .values()
                .filter(|other| other.parent == Some(id))
                .map(|other| format!("list '{}'", other.name)),
        );
        users.extend(
            self.line_items
                .values()
                .filter(|li| li.module != properties)
                .filter(|li| {
                    li.applies_to
                        .as_ref()
                        .is_some_and(|axes| axes.contains(&axis))
                        || li.format == Format::List { list: id }
                })
                .map(|li| format!("line item '{}'", self.qualified_name(li))),
        );
        in_use("List", &list.name, users)?;
        let properties_items = self.line_item_ids_of(properties);
        self.ensure_line_items_free("List", &list.name, &properties_items)?;

        self.drop_module(properties);
        self.lists.remove(&id);
        Ok(())
    }

    pub(super) fn upsert_items(
        &mut self,
        list_id: ListId,
        specs: Vec<ItemSpec>,
    ) -> Result<(), EngineError> {
        let list = self
            .lists
            .get(&list_id)
            .ok_or_else(|| not_found("list", list_id.0))?;
        let parent_list = list
            .parent
            .map(|parent| {
                self.lists
                    .get(&parent)
                    .ok_or_else(|| not_found("list", parent.0))
            })
            .transpose()?;

        let mut names: HashMap<String, ItemId> = HashMap::new();
        let mut codes: HashMap<String, ItemId> = HashMap::new();
        for (_, item) in list.items() {
            if !list.numbered {
                names.insert(fold(&item.name), item.id);
            }
            if let Some(code) = &item.code {
                codes.insert(code.clone(), item.id);
            }
        }
        let mut seen = HashSet::new();
        let mut planned = Vec::with_capacity(specs.len());
        for spec in specs {
            if !seen.insert(spec.id) {
                return Err(invalid(format!(
                    "Item {} appears more than once in the command.",
                    spec.id.0
                )));
            }
            if list.was_deleted(spec.id) {
                return Err(invalid(format!("Item {} was deleted.", spec.id.0)));
            }
            let existing = list.idx(spec.id);
            if let Some(idx) = existing {
                let current = list.item(idx);
                names.remove(&fold(&current.name));
                if let Some(code) = &current.code {
                    codes.remove(code);
                }
            }
            let name = clean_name("item", &spec.name)?;
            let code = spec
                .code
                .map(|code| code.trim().to_string())
                .filter(|code| !code.is_empty());
            if !list.numbered && names.insert(fold(&name), spec.id).is_some() {
                return Err(EngineError::NameTaken { what: "item", name });
            }
            if let Some(code) = &code
                && codes.insert(code.clone(), spec.id).is_some()
            {
                return Err(EngineError::NameTaken {
                    what: "item code",
                    name: code.clone(),
                });
            }
            match (parent_list, spec.parent) {
                (Some(parent_list), Some(parent)) => {
                    if parent_list.idx(parent).is_none() {
                        return Err(invalid(format!(
                            "Parent {} of item '{name}' is not an item of list '{}'.",
                            parent.0, parent_list.name
                        )));
                    }
                }
                (Some(parent_list), None) => {
                    return Err(invalid(format!(
                        "Item '{name}' needs a parent item from list '{}'.",
                        parent_list.name
                    )));
                }
                (None, Some(_)) => {
                    return Err(invalid(format!(
                        "Item '{name}' cannot have a parent because list '{}' has no parent list.",
                        list.name
                    )));
                }
                (None, None) => {}
            }
            planned.push(PlannedItem {
                id: spec.id,
                existing,
                code,
                name,
                parent: spec.parent,
            });
        }

        let list = self.list_mut(list_id)?;
        for plan in planned {
            let item = Item {
                id: plan.id,
                code: plan.code,
                name: plan.name,
                parent: plan.parent,
                deleted: false,
            };
            match plan.existing {
                Some(idx) => list.items[idx as usize] = item,
                None => {
                    list.index.insert(item.id, list.items.len() as u32);
                    list.items.push(item);
                }
            }
        }
        Ok(())
    }

    pub(super) fn delete_items(
        &mut self,
        list_id: ListId,
        ids: Vec<ItemId>,
    ) -> Result<(), EngineError> {
        let list = self
            .lists
            .get(&list_id)
            .ok_or_else(|| not_found("list", list_id.0))?;
        let mut doomed = HashSet::new();
        let mut indices = Vec::new();
        for id in ids {
            let idx = list.idx(id).ok_or_else(|| not_found("list item", id.0))?;
            if doomed.insert(id) {
                indices.push(idx);
            }
        }
        let orphans: Vec<String> = self
            .lists
            .values()
            .filter(|child| child.parent == Some(list_id))
            .flat_map(|child| {
                child
                    .items()
                    .filter(|(_, item)| item.parent.is_some_and(|parent| doomed.contains(&parent)))
                    .map(|(_, item)| format!("'{}' in list '{}'", item.name, child.name))
            })
            .collect();
        if !orphans.is_empty() {
            return Err(invalid(format!(
                "Items that still have child items cannot be deleted; delete {} first.",
                orphans.join(", ")
            )));
        }

        let list = self.list_mut(list_id)?;
        for idx in indices {
            list.items[idx as usize].deleted = true;
        }
        for subset in self
            .subsets
            .values_mut()
            .filter(|subset| subset.list == list_id)
        {
            subset.items.retain(|item| !doomed.contains(item));
        }
        Ok(())
    }

    pub(super) fn create_subset(
        &mut self,
        id: SubsetId,
        list: ListId,
        name: String,
        items: Vec<ItemId>,
    ) -> Result<(), EngineError> {
        if self.subsets.contains_key(&id) {
            return Err(already_exists("subset", id.0));
        }
        let name = check_name(
            "subset",
            &name,
            self.subsets.values().map(|subset| subset.name.as_str()),
        )?;
        let source = self
            .lists
            .get(&list)
            .ok_or_else(|| not_found("list", list.0))?;
        check_subset_items(source, &items)?;
        self.subsets.insert(
            id,
            Subset {
                id,
                list,
                name,
                items,
            },
        );
        Ok(())
    }

    pub(super) fn update_subset(
        &mut self,
        id: SubsetId,
        name: Option<String>,
        items: Option<Vec<ItemId>>,
    ) -> Result<(), EngineError> {
        let subset = self
            .subsets
            .get(&id)
            .ok_or_else(|| not_found("subset", id.0))?;
        let name = name
            .map(|name| {
                check_name(
                    "subset",
                    &name,
                    self.subsets
                        .values()
                        .filter(|other| other.id != id)
                        .map(|other| other.name.as_str()),
                )
            })
            .transpose()?;
        if let Some(items) = &items {
            let source = self
                .lists
                .get(&subset.list)
                .ok_or_else(|| not_found("list", subset.list.0))?;
            check_subset_items(source, items)?;
        }

        let subset = self
            .subsets
            .get_mut(&id)
            .ok_or_else(|| not_found("subset", id.0))?;
        if let Some(name) = name {
            subset.name = name;
        }
        if let Some(items) = items {
            subset.items = items;
        }
        Ok(())
    }

    pub(super) fn delete_subset(&mut self, id: SubsetId) -> Result<(), EngineError> {
        let subset = self
            .subsets
            .get(&id)
            .ok_or_else(|| not_found("subset", id.0))?;
        let axis = AxisSpec::Subset { subset: id };
        let mut users: Vec<String> = self
            .modules
            .values()
            .filter(|module| module.axes.contains(&axis))
            .map(|module| format!("module '{}'", module.name))
            .collect();
        users.extend(
            self.line_items
                .values()
                .filter(|li| {
                    li.applies_to
                        .as_ref()
                        .is_some_and(|axes| axes.contains(&axis))
                })
                .map(|li| format!("line item '{}'", self.qualified_name(li))),
        );
        in_use("Subset", &subset.name, users)?;
        self.subsets.remove(&id);
        Ok(())
    }

    fn list_mut(&mut self, id: ListId) -> Result<&mut List, EngineError> {
        self.lists
            .get_mut(&id)
            .ok_or_else(|| not_found("list", id.0))
    }
}

/// The built-in dimensions are named in formulas as `Versions` and `Time`, which a list of
/// that name would make ambiguous.
fn check_not_reserved(name: &str) -> Result<(), EngineError> {
    for reserved in ["Versions", "Time"] {
        if same_name(name, reserved) {
            return Err(invalid(format!("'{reserved}' is a reserved name.")));
        }
    }
    Ok(())
}

/// Subset members must be distinct live items of the subset's list.
fn check_subset_items(list: &List, items: &[ItemId]) -> Result<(), EngineError> {
    let mut seen = HashSet::new();
    for item in items {
        if list.idx(*item).is_none() {
            return Err(not_found("list item", item.0));
        }
        if !seen.insert(*item) {
            return Err(invalid(format!(
                "Item {} appears more than once in the subset.",
                item.0
            )));
        }
    }
    Ok(())
}
