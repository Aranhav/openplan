//! The rows that pass the filters of a view, kept for a model while a window scrolls over them.
//!
//! Finding them reads every row of the view, which takes seconds for the most rows a filtered view
//! may have, and a grid asks for a new window at every scroll. They are kept by the view, the
//! query without its window, and by the sequence number of the model they were found in: a change
//! of the model may change which rows pass, so a change drops all of them.

use std::{
    fmt,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use openplan_engine::{ViewQuery, Window, view::PassingRows};

/// How many views a model keeps the rows of.
const MAX_ENTRIES: usize = 4;
/// How many rows all the views of a model hold between them: the most that one filtered view may
/// have. Each takes 8 bytes.
const MAX_ROWS: usize = 2_000_000;

struct Entry {
    /// The query with its window cleared.
    query: ViewQuery,
    passing: PassingRows,
}

struct Kept {
    /// The sequence number of the model that every entry was found in.
    seq: i64,
    /// The one used last first.
    entries: Vec<Entry>,
}

/// The rows that pass the filters of the last few views of one model.
pub struct PassingCache {
    kept: Mutex<Kept>,
}

/// The query as the cache knows the view: whatever window it asks for.
fn view_of(query: &ViewQuery) -> ViewQuery {
    ViewQuery {
        window: Window {
            row_offset: 0,
            row_limit: 0,
            col_offset: 0,
            col_limit: 0,
        },
        ..query.clone()
    }
}

impl PassingCache {
    pub fn new() -> PassingCache {
        PassingCache {
            kept: Mutex::new(Kept {
                seq: i64::MIN,
                entries: Vec::new(),
            }),
        }
    }

    fn kept(&self) -> MutexGuard<'_, Kept> {
        self.kept.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The rows that pass the filters of the view `query` asks for in the model as of `seq`,
    /// if they were kept, whatever the window of the query.
    pub fn get(&self, seq: i64, query: &ViewQuery) -> Option<PassingRows> {
        let view = view_of(query);
        let mut kept = self.kept();
        if kept.seq != seq {
            return None;
        }
        let at = kept.entries.iter().position(|entry| entry.query == view)?;
        let entry = kept.entries.remove(at);
        let passing = Arc::clone(&entry.passing);
        kept.entries.insert(0, entry);
        Some(passing)
    }

    /// Keeps the rows that pass the filters of the view `query` asks for in the model as of
    /// `seq`, and lets go of the views used least, so that no more than a few, and 2,000,000 rows
    /// between them, are kept. A model that has moved on since `seq` keeps nothing of it.
    pub fn put(&self, seq: i64, query: &ViewQuery, passing: PassingRows) {
        if passing.len() > MAX_ROWS {
            return;
        }
        let view = view_of(query);
        let mut kept = self.kept();
        if seq < kept.seq {
            return;
        }
        if seq > kept.seq {
            kept.seq = seq;
            kept.entries.clear();
        }
        kept.entries.retain(|entry| entry.query != view);
        kept.entries.insert(
            0,
            Entry {
                query: view,
                passing,
            },
        );
        let mut rows = 0;
        let mut keep = 0;
        for entry in &kept.entries {
            rows += entry.passing.len();
            if keep == MAX_ENTRIES || rows > MAX_ROWS {
                break;
            }
            keep += 1;
        }
        kept.entries.truncate(keep);
    }

    /// How many views have their rows kept.
    pub fn len(&self) -> usize {
        self.kept().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl fmt::Debug for PassingCache {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PassingCache")
            .field("views", &self.len())
            .finish()
    }
}

impl Default for PassingCache {
    fn default() -> Self {
        PassingCache::new()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::*;

    /// A view of one module that keeps the rows over `above`, on the window starting at `offset`.
    fn view(above: f64, offset: usize) -> ViewQuery {
        serde_json::from_value(json!({
            "module": Uuid::nil(),
            "rows": [{ "kind": "time" }],
            "columns": [{ "kind": "line_items" }],
            "filters": [{
                "line_item": Uuid::nil(),
                "op": "gt",
                "value": { "t": "number", "v": above },
            }],
            "window": {
                "row_offset": offset, "row_limit": 50, "col_offset": 0, "col_limit": 20,
            },
        }))
        .unwrap()
    }

    fn rows(count: usize) -> PassingRows {
        Arc::new((0..count).collect())
    }

    #[test]
    fn a_window_that_moves_finds_the_rows_that_were_kept() {
        let cache = PassingCache::new();
        let kept = rows(10);
        cache.put(7, &view(1.0, 0), Arc::clone(&kept));

        let found = cache.get(7, &view(1.0, 400)).unwrap();

        assert!(Arc::ptr_eq(&found, &kept));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn another_view_or_another_model_state_finds_nothing() {
        let cache = PassingCache::new();
        cache.put(7, &view(1.0, 0), rows(10));

        assert!(cache.get(7, &view(2.0, 0)).is_none());
        assert!(cache.get(8, &view(1.0, 0)).is_none());
        assert!(cache.get(6, &view(1.0, 0)).is_none());
    }

    #[test]
    fn a_change_of_the_model_drops_what_was_kept_of_an_earlier_state() {
        let cache = PassingCache::new();
        cache.put(7, &view(1.0, 0), rows(10));
        cache.put(7, &view(2.0, 0), rows(10));
        assert_eq!(cache.len(), 2);

        cache.put(8, &view(3.0, 0), rows(10));

        assert_eq!(cache.len(), 1);
        assert!(cache.get(7, &view(1.0, 0)).is_none());
        assert!(cache.get(8, &view(3.0, 0)).is_some());
    }

    #[test]
    fn rows_found_in_a_state_the_model_has_left_are_not_kept() {
        let cache = PassingCache::new();
        cache.put(8, &view(1.0, 0), rows(10));

        cache.put(7, &view(2.0, 0), rows(10));

        assert_eq!(cache.len(), 1);
        assert!(cache.get(8, &view(1.0, 0)).is_some());
    }

    #[test]
    fn the_view_used_least_is_let_go_of_after_four() {
        let cache = PassingCache::new();
        for above in 1..=4 {
            cache.put(7, &view(f64::from(above), 0), rows(10));
        }
        // Using the first makes the second the one used least.
        assert!(cache.get(7, &view(1.0, 0)).is_some());

        cache.put(7, &view(5.0, 0), rows(10));

        assert_eq!(cache.len(), 4);
        assert!(cache.get(7, &view(2.0, 0)).is_none());
        for above in [1.0, 3.0, 4.0, 5.0] {
            assert!(cache.get(7, &view(above, 0)).is_some(), "{above}");
        }
    }

    #[test]
    fn keeping_a_view_again_replaces_it() {
        let cache = PassingCache::new();
        cache.put(7, &view(1.0, 0), rows(10));
        let again = rows(3);

        cache.put(7, &view(1.0, 50), Arc::clone(&again));

        assert_eq!(cache.len(), 1);
        assert!(Arc::ptr_eq(&cache.get(7, &view(1.0, 0)).unwrap(), &again));
    }

    #[test]
    fn the_views_kept_hold_2000000_rows_between_them_at_most() {
        let cache = PassingCache::new();
        cache.put(7, &view(1.0, 0), rows(1_200_000));
        cache.put(7, &view(2.0, 0), rows(700_000));
        assert_eq!(cache.len(), 2);

        cache.put(7, &view(3.0, 0), rows(500_000));

        // 500,000 and 700,000 fit together, and the 1,200,000 do not fit with them.
        assert_eq!(cache.len(), 2);
        assert!(cache.get(7, &view(1.0, 0)).is_none());

        cache.put(7, &view(4.0, 0), rows(2_000_001));
        assert_eq!(cache.len(), 2, "a set over the limit is not kept");
        cache.put(7, &view(5.0, 0), rows(2_000_000));
        assert_eq!(cache.len(), 1);
        assert!(cache.get(7, &view(5.0, 0)).is_some());
    }
}
