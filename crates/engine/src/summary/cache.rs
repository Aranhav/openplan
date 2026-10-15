//! The cache of rolled-up columns that a model serves reads from, and the stamps that tell
//! whether an entry is still current.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::command::ChangeSet;
use crate::ids::LineItemId;
use crate::shape::Shape;
use crate::structure::Structure;
use crate::value::Column;

use super::LevelSpec;

/// A rolled-up grid: its shape and cells.
pub(crate) type Summary = (Shape, Column);

/// What a cached summary was computed from. The summary is current exactly while this equals
/// the model's present fingerprint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Fingerprint {
    structure: u64,
    line_item: u64,
    ratio_parts: Option<(u64, u64)>,
}

#[derive(Clone)]
struct CacheEntry {
    fingerprint: Fingerprint,
    summary: Arc<Summary>,
}

type Entries = HashMap<LineItemId, HashMap<LevelSpec, CacheEntry>>;

/// Source of the stamps that mark a change of the structure or of a line item's cells.
///
/// Stamps are unique across the whole process and not just within one model. Models that
/// share a cache through `Clone` and then diverge therefore never mistake each other's
/// summaries for their own.
static NEXT_STAMP: AtomicU64 = AtomicU64::new(1);

fn fresh_stamp() -> u64 {
    NEXT_STAMP.fetch_add(1, Ordering::Relaxed)
}

/// The cached summaries of a model, and the stamps that tell whether they are still current.
///
/// Cloning is cheap: clones share the cached entries, which are keyed by line item and levels
/// and checked against a [`Fingerprint`] on every read, and copy the stamps.
#[derive(Clone, Default)]
pub(crate) struct SummaryCache {
    entries: Arc<Mutex<Entries>>,
    /// Stamp of the latest structural change; summaries depend on hierarchies, calendars and
    /// summary methods.
    structure: u64,
    /// Stamp of the latest change of each line item's cells.
    line_items: HashMap<LineItemId, u64>,
}

impl SummaryCache {
    /// Takes note of an applied change: a structural change invalidates every summary, and
    /// a change of a line item's cells those of the line item and of the ratios that divide
    /// it, whose fingerprints include its stamp.
    pub(crate) fn record(&mut self, structure: &Structure, changes: &ChangeSet) {
        if changes.structure_changed {
            self.structure = fresh_stamp();
            self.lock().clear();
        }
        for id in &changes.changed_line_items {
            if structure.line_item(*id).is_some() {
                self.line_items.insert(*id, fresh_stamp());
            } else {
                self.line_items.remove(id);
            }
        }
    }

    pub(crate) fn fingerprint(
        &self,
        line_item: LineItemId,
        ratio_parts: Option<(LineItemId, LineItemId)>,
    ) -> Fingerprint {
        let stamp = |id: &LineItemId| self.line_items.get(id).copied().unwrap_or(0);
        Fingerprint {
            structure: self.structure,
            line_item: stamp(&line_item),
            ratio_parts: ratio_parts
                .map(|(numerator, denominator)| (stamp(&numerator), stamp(&denominator))),
        }
    }

    /// The cached summary of `line_item` at `levels`, if it was computed from `fingerprint`.
    pub(crate) fn get(
        &self,
        line_item: LineItemId,
        levels: &LevelSpec,
        fingerprint: &Fingerprint,
    ) -> Option<Arc<Summary>> {
        let entries = self.lock();
        let entry = entries.get(&line_item)?.get(levels)?;
        (entry.fingerprint == *fingerprint).then(|| Arc::clone(&entry.summary))
    }

    pub(crate) fn insert(
        &self,
        line_item: LineItemId,
        levels: &LevelSpec,
        fingerprint: Fingerprint,
        summary: Arc<Summary>,
    ) {
        self.lock().entry(line_item).or_default().insert(
            levels.clone(),
            CacheEntry {
                fingerprint,
                summary,
            },
        );
    }

    /// The entries, which stay consistent even if a thread panicked while holding the lock.
    fn lock(&self) -> MutexGuard<'_, Entries> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl fmt::Debug for SummaryCache {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let entries: usize = self.lock().values().map(HashMap::len).sum();
        f.debug_struct("SummaryCache")
            .field("entries", &entries)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::Calendar;
    use crate::command::{CellEdit, Command, CoordToken, ItemSpec};
    use crate::ids::{ItemId, ListId, ModuleId};
    use crate::model::Model;
    use crate::shape::Axis;
    use crate::structure::{AxisSpec, LineItem, SummaryMethod, TimeScale, VersionsScope};
    use crate::value::{Format, Value};

    struct Fixture {
        model: Model,
        list: ListId,
        items: Vec<ItemId>,
        units: LineItemId,
        other: LineItemId,
    }

    fn fixture() -> Fixture {
        let mut model = Model::new(Calendar {
            fiscal_year_start_month: 1,
            first_year: 2026,
            years: 1,
            current_month: None,
        });
        let list = ListId::new();
        let module = ModuleId::new();
        let items: Vec<ItemId> = (0..2).map(|_| ItemId::new()).collect();
        let [units, other] = std::array::from_fn(|_| LineItemId::new());
        let line_item = |id, name: &str| LineItem {
            id,
            module,
            name: name.to_string(),
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
        };
        model
            .apply_batch(vec![
                Command::CreateList {
                    id: list,
                    name: "Products".to_string(),
                    parent: None,
                    top_level_name: None,
                    numbered: false,
                    production_data: false,
                },
                Command::UpsertListItems {
                    list,
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
                    axes: vec![AxisSpec::List { list }],
                    functional_area: String::new(),
                },
                Command::CreateLineItem(line_item(units, "Units")),
                Command::CreateLineItem(line_item(other, "Other")),
            ])
            .unwrap();
        Fixture {
            model,
            list,
            items,
            units,
            other,
        }
    }

    fn summary_of(model: &Model, id: LineItemId, list: ListId) -> Arc<Summary> {
        let line_item = model.structure().line_item(id).unwrap();
        let layout = model.structure().layout(line_item).unwrap();
        model
            .summary_column(line_item, &layout, &LevelSpec(vec![Axis::ListTop(list)]))
            .unwrap()
    }

    fn write(model: &mut Model, line_item: LineItemId, item: ItemId, value: f64) {
        model
            .apply(Command::SetCells {
                line_item,
                edits: vec![CellEdit {
                    coords: vec![CoordToken::Item(item)],
                    value: Value::Number(value),
                }],
            })
            .unwrap();
    }

    #[test]
    fn repeated_reads_share_the_cached_summary() {
        let Fixture {
            model, list, units, ..
        } = fixture();
        let first = summary_of(&model, units, list);
        let second = summary_of(&model, units, list);
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn an_edit_replaces_only_the_summary_of_its_line_item() {
        let Fixture {
            mut model,
            list,
            items,
            units,
            other,
        } = fixture();
        let before = summary_of(&model, units, list);
        let untouched = summary_of(&model, other, list);

        write(&mut model, units, items[0], 5.0);
        let after = summary_of(&model, units, list);
        assert!(!Arc::ptr_eq(&before, &after));
        assert_eq!(after.1, Column::Number(vec![5.0]));
        assert!(Arc::ptr_eq(&untouched, &summary_of(&model, other, list)));
        assert!(Arc::ptr_eq(&after, &summary_of(&model, units, list)));
    }

    #[test]
    fn a_structural_change_replaces_every_summary() {
        let Fixture {
            mut model,
            list,
            units,
            other,
            ..
        } = fixture();
        let units_before = summary_of(&model, units, list);
        let other_before = summary_of(&model, other, list);
        model
            .apply(Command::CreateList {
                id: ListId::new(),
                name: "Regions".to_string(),
                parent: None,
                top_level_name: None,
                numbered: false,
                production_data: false,
            })
            .unwrap();
        assert!(!Arc::ptr_eq(
            &units_before,
            &summary_of(&model, units, list)
        ));
        assert!(!Arc::ptr_eq(
            &other_before,
            &summary_of(&model, other, list)
        ));
    }

    #[test]
    fn rejected_changes_keep_the_cached_summaries() {
        let Fixture {
            mut model,
            list,
            items,
            units,
            ..
        } = fixture();
        let cached = summary_of(&model, units, list);
        let rejected = vec![
            Command::SetCells {
                line_item: units,
                edits: vec![CellEdit {
                    coords: vec![CoordToken::Item(items[0])],
                    value: Value::Number(9.0),
                }],
            },
            Command::DeleteList { id: list },
        ];
        model.apply_batch(rejected).unwrap_err();
        model.apply(Command::DeleteList { id: list }).unwrap_err();
        assert!(Arc::ptr_eq(&cached, &summary_of(&model, units, list)));
    }

    #[test]
    fn clones_share_the_cache_until_they_change() {
        let Fixture {
            model,
            list,
            items,
            units,
            ..
        } = fixture();
        let cached = summary_of(&model, units, list);
        let mut clone = model.clone();
        assert!(Arc::ptr_eq(&cached, &summary_of(&clone, units, list)));

        write(&mut clone, units, items[0], 3.0);
        assert_eq!(summary_of(&clone, units, list).1, Column::Number(vec![3.0]));
        assert_eq!(summary_of(&model, units, list).1, Column::Number(vec![0.0]));
    }
}
