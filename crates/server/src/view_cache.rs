//! The rows that pass the filters of a view, kept while a window scrolls over them.
//!
//! Finding them reads every row of the view, which takes seconds for the most rows a filtered view
//! may have, and a grid asks for a new window at every scroll. They are kept by the model, the
//! view (the query without its window) and the sequence number of the model they were found in: a
//! change of the model may change which rows pass, so a change drops all of them at once.
//!
//! Every model's sets are kept in one [`PassingStore`] that the whole process shares, which holds
//! a few views of each model and no more than a fixed number of bytes between all of them, by the
//! room the sets really take. The set used least recently is let go of first, whichever model it
//! is of.
//!
//! A view that is not kept is found by one request at a time: the others wait for it ([`Flight`])
//! and then find the rows kept, instead of each reading the rows again.

use std::{
    collections::HashMap,
    fmt,
    mem::size_of,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
};

use openplan_engine::{MemberRef, RowFilter, ViewQuery, Window, view::PassingRows};
use tokio::sync::OwnedMutexGuard;
use uuid::Uuid;

/// How many views of one model are kept.
const MAX_VIEWS_PER_MODEL: usize = 4;
/// How many bytes the sets of all models take between them: 64 MiB, which is four of the largest
/// set a filtered view can have (2,000,000 rows of 8 bytes) with room for others.
pub const BUDGET: usize = 64 << 20;

struct Entry {
    model: Uuid,
    seq: i64,
    /// The query with its window cleared.
    view: ViewQuery,
    passing: PassingRows,
    /// What the entry takes: the room of the set and the query.
    bytes: usize,
}

#[derive(Default)]
struct Kept {
    /// The one used last first.
    entries: Vec<Entry>,
    bytes: usize,
    /// The last sequence number that each model with entries has told of.
    latest: HashMap<Uuid, i64>,
}

/// The rows that pass the filters of the views of every model, within a number of bytes.
pub struct PassingStore {
    budget: usize,
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

/// What an entry takes: the room of the set, as it is allocated and not as it is long, and the
/// members and filters of the query, with their text, which is most of what a query takes.
fn bytes_of(passing: &PassingRows, view: &ViewQuery) -> usize {
    let members = |members: &[MemberRef]| -> usize {
        members
            .iter()
            .map(|member| size_of::<MemberRef>() + member.key.len())
            .sum()
    };
    passing.capacity() * size_of::<usize>()
        + size_of::<Entry>()
        + members(&view.collapsed)
        + members(&view.hidden)
        + view.filters.len() * size_of::<RowFilter>()
        + view.line_items.as_ref().map_or(0, |ids| ids.len() * 16)
}

impl Kept {
    fn remove(&mut self, at: usize) {
        let entry = self.entries.remove(at);
        self.bytes -= entry.bytes;
    }

    fn drop_where(&mut self, doomed: impl Fn(&Entry) -> bool) {
        let mut freed = 0;
        self.entries.retain(|entry| {
            let keep = !doomed(entry);
            if !keep {
                freed += entry.bytes;
            }
            keep
        });
        self.bytes -= freed;
    }
}

impl PassingStore {
    /// A store that keeps no more than `budget` bytes.
    pub fn new(budget: usize) -> PassingStore {
        PassingStore {
            budget,
            kept: Mutex::new(Kept::default()),
        }
    }

    fn kept(&self) -> MutexGuard<'_, Kept> {
        self.kept.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn get(&self, model: Uuid, seq: i64, view: &ViewQuery) -> Option<PassingRows> {
        let mut kept = self.kept();
        let at = kept
            .entries
            .iter()
            .position(|entry| entry.model == model && entry.seq == seq && entry.view == *view)?;
        let entry = kept.entries.remove(at);
        let passing = Arc::clone(&entry.passing);
        kept.entries.insert(0, entry);
        Some(passing)
    }

    fn put(&self, model: Uuid, seq: i64, view: ViewQuery, passing: PassingRows) {
        let bytes = bytes_of(&passing, &view);
        if bytes > self.budget {
            return;
        }
        let mut kept = self.kept();
        let latest = kept.latest.get(&model).copied().unwrap_or(i64::MIN);
        if seq < latest {
            return;
        }
        if seq > latest {
            kept.latest.insert(model, seq);
            kept.drop_where(|entry| entry.model == model);
        }
        kept.drop_where(|entry| entry.model == model && entry.view == view);
        kept.bytes += bytes;
        kept.entries.insert(
            0,
            Entry {
                model,
                seq,
                view,
                passing,
                bytes,
            },
        );
        // The views of the model beyond its few, the one used least first ...
        let of_model = kept.entries.iter().filter(|e| e.model == model).count();
        for _ in MAX_VIEWS_PER_MODEL..of_model {
            let oldest = kept.entries.iter().rposition(|e| e.model == model);
            kept.remove(oldest.expect("the model has entries"));
        }
        // ... and then, of whichever model, the one used least, until the rest fit.
        while kept.bytes > self.budget {
            let oldest = kept.entries.len() - 1;
            kept.remove(oldest);
        }
    }

    /// The model has moved on to `seq`: what was found in an earlier state is let go of at once,
    /// and rows of an earlier state that are found after this are not kept.
    fn invalidate(&self, model: Uuid, seq: i64) {
        let mut kept = self.kept();
        if kept.latest.get(&model).is_some_and(|&latest| latest >= seq) {
            return;
        }
        kept.latest.insert(model, seq);
        kept.drop_where(|entry| entry.model == model && entry.seq < seq);
    }

    /// The model is not in memory any more.
    fn forget(&self, model: Uuid) {
        let mut kept = self.kept();
        kept.latest.remove(&model);
        kept.drop_where(|entry| entry.model == model);
    }

    /// How many bytes the sets kept take.
    pub fn bytes(&self) -> usize {
        self.kept().bytes
    }

    /// How many views of any model are kept.
    pub fn len(&self) -> usize {
        self.kept().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl fmt::Debug for PassingStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PassingStore")
            .field("budget", &self.budget)
            .field("bytes", &self.bytes())
            .field("views", &self.len())
            .finish()
    }
}

/// A view being found, which is a reason for the others who want it to wait.
struct InFlight {
    seq: i64,
    view: ViewQuery,
    lock: Arc<tokio::sync::Mutex<()>>,
}

/// The rows that pass the filters of the views of one model.
pub struct PassingCache {
    model: Uuid,
    store: Arc<PassingStore>,
    flights: Mutex<Vec<InFlight>>,
    found: AtomicU64,
}

/// The turn to find the rows of a view. It is held while they are found and kept, and given up by
/// dropping it, wherever the work ends, which lets the next request for the view go on.
pub struct Flight {
    cache: Arc<PassingCache>,
    lock: Arc<tokio::sync::Mutex<()>>,
    guard: Option<OwnedMutexGuard<()>>,
}

impl PassingCache {
    pub fn new(model: Uuid, store: Arc<PassingStore>) -> PassingCache {
        PassingCache {
            model,
            store,
            flights: Mutex::new(Vec::new()),
            found: AtomicU64::new(0),
        }
    }

    fn flights(&self) -> MutexGuard<'_, Vec<InFlight>> {
        self.flights.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The rows that pass the filters of the view `query` asks for in the model as of `seq`, if
    /// they were kept, whatever the window of the query.
    pub fn get(&self, seq: i64, query: &ViewQuery) -> Option<PassingRows> {
        self.store.get(self.model, seq, &view_of(query))
    }

    /// Keeps the rows that pass the filters of the view `query` asks for in the model as of
    /// `seq`, unless the model has moved on since.
    pub fn put(&self, seq: i64, query: &ViewQuery, passing: PassingRows) {
        self.found.fetch_add(1, Ordering::Relaxed);
        self.store.put(self.model, seq, view_of(query), passing);
    }

    /// The model has moved on to `seq`, and the rows found in the states before are let go of.
    pub fn invalidate(&self, seq: i64) {
        self.store.invalidate(self.model, seq);
    }

    /// The model is unloaded, and none of its rows are kept.
    pub fn forget(&self) {
        self.store.forget(self.model);
    }

    /// How many views of this model are kept.
    pub fn len(&self) -> usize {
        self.store
            .kept()
            .entries
            .iter()
            .filter(|entry| entry.model == self.model)
            .count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// How many times the rows of a view of this model were found by reading them, as against
    /// found in the cache.
    pub fn found(&self) -> u64 {
        self.found.load(Ordering::Relaxed)
    }

    /// The turn to find the rows of the view `query` asks for in the model as of `seq`, once the
    /// requests that were before for the same view have had theirs. The rows are to be looked for
    /// in the cache again once it is had, since one of them may have found them. Do not hold a
    /// permit for heavy work while waiting for it.
    pub async fn flight(self: &Arc<Self>, seq: i64, query: &ViewQuery) -> Flight {
        let view = view_of(query);
        let lock = {
            let mut flights = self.flights();
            // A turn that nobody holds or waits for is one whose request went away.
            flights.retain(|flight| Arc::strong_count(&flight.lock) > 1);
            match flights
                .iter()
                .find(|flight| flight.seq == seq && flight.view == view)
            {
                Some(flight) => Arc::clone(&flight.lock),
                None => {
                    let lock = Arc::new(tokio::sync::Mutex::new(()));
                    flights.push(InFlight {
                        seq,
                        view,
                        lock: Arc::clone(&lock),
                    });
                    lock
                }
            }
        };
        // The turn exists before it is had, so that a request that goes away while it waits
        // cleans up after itself.
        let mut flight = Flight {
            cache: Arc::clone(self),
            lock,
            guard: None,
        };
        flight.guard = Some(Arc::clone(&flight.lock).lock_owned().await);
        flight
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        self.guard = None;
        let mut flights = self.cache.flights();
        // The list and this turn hold it, and nobody else waits for it.
        if Arc::strong_count(&self.lock) == 2 {
            flights.retain(|flight| !Arc::ptr_eq(&flight.lock, &self.lock));
        }
    }
}

impl fmt::Debug for PassingCache {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PassingCache")
            .field("views", &self.len())
            .field("found", &self.found())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use tokio::time::timeout;

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

    /// What a set of `count` rows takes in a store, with the query of `view`.
    fn room(count: usize) -> usize {
        bytes_of(&rows(count), &view_of(&view(1.0, 0)))
    }

    fn store() -> Arc<PassingStore> {
        Arc::new(PassingStore::new(BUDGET))
    }

    fn cache(store: &Arc<PassingStore>) -> Arc<PassingCache> {
        Arc::new(PassingCache::new(Uuid::now_v7(), Arc::clone(store)))
    }

    #[test]
    fn a_window_that_moves_finds_the_rows_that_were_kept() {
        let cache = cache(&store());
        let kept = rows(10);
        cache.put(7, &view(1.0, 0), Arc::clone(&kept));

        let found = cache.get(7, &view(1.0, 400)).unwrap();

        assert!(Arc::ptr_eq(&found, &kept));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn another_view_or_another_model_state_finds_nothing() {
        let cache = cache(&store());
        cache.put(7, &view(1.0, 0), rows(10));

        assert!(cache.get(7, &view(2.0, 0)).is_none());
        assert!(cache.get(8, &view(1.0, 0)).is_none());
        assert!(cache.get(6, &view(1.0, 0)).is_none());
    }

    #[test]
    fn the_views_of_one_model_are_not_found_by_another() {
        let store = store();
        let (first, second) = (cache(&store), cache(&store));
        first.put(7, &view(1.0, 0), rows(10));

        assert!(second.get(7, &view(1.0, 0)).is_none());
        assert!(first.get(7, &view(1.0, 0)).is_some());
    }

    #[test]
    fn a_change_of_the_model_drops_what_was_kept_of_an_earlier_state() {
        let cache = cache(&store());
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
        let cache = cache(&store());
        cache.put(8, &view(1.0, 0), rows(10));

        cache.put(7, &view(2.0, 0), rows(10));

        assert_eq!(cache.len(), 1);
        assert!(cache.get(8, &view(1.0, 0)).is_some());
    }

    #[test]
    fn a_change_drops_the_rows_kept_at_once_and_not_at_the_next_view() {
        let store = store();
        let (changed, other) = (cache(&store), cache(&store));
        changed.put(7, &view(1.0, 0), rows(1_000));
        other.put(7, &view(1.0, 0), rows(1_000));
        let before = store.bytes();

        changed.invalidate(8);

        assert!(changed.is_empty());
        assert_eq!(other.len(), 1);
        assert_eq!(store.bytes(), before - room(1_000));
        // Rows that a slower request found in the state before are not kept either.
        changed.put(7, &view(2.0, 0), rows(1_000));
        assert!(changed.is_empty());
    }

    #[test]
    fn a_model_that_is_unloaded_keeps_nothing() {
        let store = store();
        let (gone, other) = (cache(&store), cache(&store));
        gone.put(7, &view(1.0, 0), rows(100));
        other.put(7, &view(1.0, 0), rows(100));

        gone.forget();

        assert!(gone.is_empty());
        assert_eq!(other.len(), 1);
        assert_eq!(store.bytes(), room(100));
    }

    #[test]
    fn the_view_used_least_is_let_go_of_after_four() {
        let cache = cache(&store());
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
        let store = store();
        let cache = cache(&store);
        cache.put(7, &view(1.0, 0), rows(10));
        let again = rows(3);

        cache.put(7, &view(1.0, 50), Arc::clone(&again));

        assert_eq!(cache.len(), 1);
        assert_eq!(store.bytes(), room(3));
        assert!(Arc::ptr_eq(&cache.get(7, &view(1.0, 0)).unwrap(), &again));
    }

    #[test]
    fn the_budget_is_shared_between_models_and_the_set_used_least_goes_first() {
        // Room for two sets of 1,000 rows and not three.
        let store = Arc::new(PassingStore::new(room(1_000) * 5 / 2));
        let (first, second, third) = (cache(&store), cache(&store), cache(&store));
        first.put(7, &view(1.0, 0), rows(1_000));
        second.put(7, &view(1.0, 0), rows(1_000));
        // Using the first makes the second the set used least, though it is another model's.
        assert!(first.get(7, &view(1.0, 0)).is_some());

        third.put(7, &view(1.0, 0), rows(1_000));

        assert!(second.get(7, &view(1.0, 0)).is_none());
        assert!(first.get(7, &view(1.0, 0)).is_some());
        assert!(third.get(7, &view(1.0, 0)).is_some());
        assert!(store.bytes() <= room(1_000) * 5 / 2);
    }

    #[test]
    fn a_set_counts_by_the_room_it_has_and_not_by_its_length() {
        let store = Arc::new(PassingStore::new(room(1_000) * 3 / 2));
        let cache = cache(&store);
        // 10 rows in the room of 100,000.
        let mut roomy = Vec::with_capacity(100_000);
        roomy.extend(0..10);

        cache.put(7, &view(1.0, 0), Arc::new(roomy));

        assert!(cache.is_empty());
        let mut snug = Vec::with_capacity(1_000);
        snug.extend(0..1_000);
        cache.put(7, &view(1.0, 0), Arc::new(snug));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn a_set_over_the_whole_budget_is_not_kept_and_costs_the_others_nothing() {
        let store = Arc::new(PassingStore::new(room(1_000) * 3 / 2));
        let cache = cache(&store);
        cache.put(7, &view(1.0, 0), rows(100));

        cache.put(7, &view(2.0, 0), rows(2_000));

        assert_eq!(cache.len(), 1);
        assert!(cache.get(7, &view(1.0, 0)).is_some());
    }

    #[test]
    fn a_query_with_many_hidden_members_counts_for_the_room_it_takes() {
        let plain = view_of(&view(1.0, 0));
        let mut hidden = plain.clone();
        hidden.hidden = (0..5_000)
            .map(|at| MemberRef {
                dim: openplan_engine::ViewDim::Time,
                key: format!("Period {at}"),
            })
            .collect();

        assert!(bytes_of(&rows(0), &hidden) > bytes_of(&rows(0), &plain) + 5_000 * 40);
    }

    #[tokio::test]
    async fn a_view_is_found_by_one_request_at_a_time() {
        let cache = cache(&store());
        let first = cache.flight(7, &view(1.0, 0)).await;

        // The same view with another window waits for the first.
        let second = tokio::spawn({
            let cache = Arc::clone(&cache);
            async move { cache.flight(7, &view(1.0, 300)).await }
        });
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        cache.put(7, &view(1.0, 0), rows(10));
        drop(first);

        let second = timeout(Duration::from_secs(5), second)
            .await
            .unwrap()
            .unwrap();
        // It finds what the first kept.
        assert!(cache.get(7, &view(1.0, 300)).is_some());
        drop(second);
        assert!(cache.flights().is_empty());
    }

    #[tokio::test]
    async fn another_view_or_state_does_not_wait() {
        let cache = cache(&store());
        let _first = cache.flight(7, &view(1.0, 0)).await;

        let other_view = timeout(Duration::from_secs(5), cache.flight(7, &view(2.0, 0))).await;
        let other_state = timeout(Duration::from_secs(5), cache.flight(8, &view(1.0, 0))).await;

        assert!(other_view.is_ok());
        assert!(other_state.is_ok());
    }

    #[tokio::test]
    async fn a_request_that_goes_away_while_it_waits_leaves_nothing_behind() {
        let cache = cache(&store());
        let first = cache.flight(7, &view(1.0, 0)).await;
        let waiting = tokio::spawn({
            let cache = Arc::clone(&cache);
            async move { cache.flight(7, &view(1.0, 0)).await }
        });
        tokio::task::yield_now().await;
        assert_eq!(cache.flights().len(), 1);

        waiting.abort();
        let _ = waiting.await;
        drop(first);

        assert!(cache.flights().is_empty());
        timeout(Duration::from_secs(5), cache.flight(7, &view(1.0, 0)))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn the_next_request_goes_on_when_the_one_before_it_found_nothing() {
        let cache = cache(&store());
        let first = cache.flight(7, &view(1.0, 0)).await;
        let next = tokio::spawn({
            let cache = Arc::clone(&cache);
            async move { cache.flight(7, &view(1.0, 0)).await }
        });
        tokio::task::yield_now().await;

        // The first ended with an error and kept nothing.
        drop(first);

        let next = timeout(Duration::from_secs(5), next)
            .await
            .unwrap()
            .unwrap();
        assert!(cache.get(7, &view(1.0, 0)).is_none());
        drop(next);
        assert!(cache.flights().is_empty());
    }
}
