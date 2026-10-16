//! The models held in memory, one actor each (spec §4).
//!
//! A model is loaded from the database when it is first used and then owned by an actor, a task
//! that applies the batches of commands sent to it one at a time. A batch is applied to a clone
//! of the model, stored in the change log and only then becomes the model: whatever fails on the
//! way leaves the model as it was. After each batch the actor publishes the new model for
//! readers, which never wait for it, and tells the subscribers what changed. Once enough changes
//! have piled up in the log the actor has a checkpoint of the model saved, by a task of its own
//! so that edits go on meanwhile, and it saves a last one when it stops.
//!
//! The [`ModelRegistry`] starts the actors and hands out [`ModelHandle`]s to them. It unloads
//! models that are not used for a while and keeps at most one actor per model: two actors for
//! one model would each apply batches to a model that misses the other's.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

use anyhow::anyhow;
use openplan_engine::{ChangeSet, Command, CoordToken, LineItemId, Model, Value};
use sqlx::PgPool;
use tokio::{
    sync::{Semaphore, broadcast, mpsc, oneshot, watch},
    task::{JoinError, JoinHandle, JoinSet},
    time::MissedTickBehavior,
};
use uuid::Uuid;

use crate::{
    engine_store,
    error::{AppError, AppResult},
    view_cache::{self, PassingCache, PassingStore},
};

/// How many change-log rows, batches and the cells they changed, pile up before an actor has a
/// checkpoint of its model saved.
const CHECKPOINT_AFTER_ROWS: u64 = 10_000;
/// After a checkpoint failed, how many more rows pile up before the next try ...
const RETRY_AFTER_ROWS: u64 = 1_000;
/// ... or how long the actor waits, at the next batch, whichever comes first.
const RETRY_AFTER: Duration = Duration::from_secs(5 * 60);
/// How many requests wait for an actor before the ones sending them have to wait too.
const MAILBOX_SIZE: usize = 256;
/// How many events a slow subscriber may fall behind by before it misses some.
const EVENT_BUFFER: usize = 1024;
/// How often the server looks for models that are not used any more.
const EVICTION_INTERVAL: Duration = Duration::from_secs(60);

/// What an applied batch did to a model, told to everyone who follows it.
#[derive(Clone, Debug, PartialEq)]
pub enum ModelEvent {
    /// Cells were written and the cells that depend on them calculated again.
    CellsChanged {
        seq: i64,
        /// The line items whose cells changed, those that were typed in and those calculated.
        line_item_ids: Vec<LineItemId>,
        user_id: Uuid,
    },
    /// Lists, time, versions, modules or line items changed.
    StructureChanged { seq: i64 },
}

/// What came of an applied batch.
#[derive(Clone, Debug)]
pub struct ApplyOutcome {
    /// The change-log sequence number of the batch, which is the one of the last batch applied
    /// when the batch was empty.
    pub seq: i64,
    pub change_set: ChangeSet,
}

/// The model as an actor last published it, with the sequence number of the last batch in it.
#[derive(Clone, Debug)]
struct Published {
    model: Arc<Model>,
    seq: i64,
}

/// Makes the commands of a batch from the model they are applied to.
type Build = Box<dyn FnOnce(&Model) -> AppResult<Vec<Command>> + Send>;

enum Request {
    Apply {
        user_id: Uuid,
        build: Build,
        reply: oneshot::Sender<AppResult<ApplyOutcome>>,
    },
    /// Ends the actor once the requests before this one are done.
    Stop { checkpoint: bool },
}

/// A way to reach the actor of a model. Cheap to clone; every clone reaches the same actor, for
/// as long as it runs. Once the actor has stopped, `apply` fails, `snapshot` shows the model as
/// it was and `subscribe` gives a channel that is closed.
#[derive(Clone, Debug)]
pub struct ModelHandle {
    model_id: Uuid,
    mailbox: mpsc::Sender<Request>,
    published: watch::Receiver<Published>,
    /// Weak, so that the channel closes with the actor and not when the last handle is gone.
    events: broadcast::WeakSender<ModelEvent>,
    last_used: Arc<Mutex<Instant>>,
    /// The rows that pass the filters of the views read lately, which go with the model for as
    /// long as it is loaded.
    passing: Arc<PassingCache>,
}

impl ModelHandle {
    /// Applies the commands as one batch, all or nothing, on behalf of `user_id`.
    ///
    /// A batch the engine rejects fails with [`AppError::Engine`], and one that cannot be stored
    /// with `Internal` (`NotFound` when the model is gone); either way nothing was changed. An
    /// empty batch changes nothing and is not stored: its outcome has the sequence number of the
    /// last batch applied and no change.
    pub async fn apply(&self, user_id: Uuid, cmds: Vec<Command>) -> AppResult<ApplyOutcome> {
        self.apply_with(user_id, move |_| Ok(cmds)).await
    }

    /// Applies the commands that `build` makes from the model, as `apply` does. `build` runs in
    /// the actor, on the model the batch is applied to, so a change made from what the model has,
    /// such as adding to a name, cannot miss the batches applied before it. An error from `build`
    /// is the result and nothing is written.
    pub async fn apply_with(
        &self,
        user_id: Uuid,
        build: impl FnOnce(&Model) -> AppResult<Vec<Command>> + Send + 'static,
    ) -> AppResult<ApplyOutcome> {
        self.touch();
        let (reply, outcome) = oneshot::channel();
        self.mailbox
            .send(Request::Apply {
                user_id,
                build: Box::new(build),
                reply,
            })
            .await
            .map_err(|_| self.stopped())?;
        outcome.await.map_err(|_| self.stopped())?
    }

    /// Applies the commands that `build` makes from the model, as `apply_with` does, and returns
    /// the answer that `build` made along with them: what the change did, such as the item as it
    /// is now. Both come from the model the batch is applied to, so the answer is what this change
    /// made whatever else is applied meanwhile.
    pub async fn apply_with_answer<T: Send + 'static>(
        &self,
        user_id: Uuid,
        build: impl FnOnce(&Model) -> AppResult<(Vec<Command>, T)> + Send + 'static,
    ) -> AppResult<T> {
        let (send, receive) = oneshot::channel();
        self.apply_with(user_id, move |model| {
            let (commands, answer) = build(model)?;
            // Nobody waiting for the answer is no reason not to apply the batch.
            let _ = send.send(answer);
            Ok(commands)
        })
        .await?;
        receive
            .await
            .map_err(|_| AppError::Internal(anyhow!("the change was applied without an answer")))
    }

    /// The model as of the last batch applied.
    pub fn snapshot(&self) -> Arc<Model> {
        Arc::clone(&self.published.borrow().model)
    }

    /// The model together with the sequence number of the last batch in it.
    pub fn snapshot_seq(&self) -> (Arc<Model>, i64) {
        let published = self.published.borrow();
        (Arc::clone(&published.model), published.seq)
    }

    /// The rows that pass the filters of the views read lately.
    pub fn passing_cache(&self) -> Arc<PassingCache> {
        Arc::clone(&self.passing)
    }

    /// Follows the batches applied from now on. The channel closes when the actor stops, so
    /// that a subscriber waiting for the next event finds out; one that falls too far behind
    /// misses events and must read the snapshot again.
    pub fn subscribe(&self) -> broadcast::Receiver<ModelEvent> {
        match self.events.upgrade() {
            Some(events) => events.subscribe(),
            None => broadcast::channel(1).1,
        }
    }

    /// How many subscriptions follow the model. A model that has some is not unloaded for being
    /// idle.
    pub fn subscribers(&self) -> usize {
        self.events
            .upgrade()
            .map_or(0, |events| events.receiver_count())
    }

    fn stopped(&self) -> AppError {
        AppError::Internal(anyhow!("the actor of model {} has stopped", self.model_id))
    }

    fn touch(&self) {
        *self
            .last_used
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }

    fn idle_for(&self) -> Duration {
        self.last_used
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .elapsed()
    }

    fn is_stopped(&self) -> bool {
        self.mailbox.is_closed()
    }
}

/// What became of a request to apply a batch.
enum Applied {
    /// The model is now what the result says, and the database agrees.
    Settled(AppResult<ApplyOutcome>),
    /// The transaction failed while committing, so the batch may or may not be stored and the
    /// model in memory may or may not be the one in the database. The actor cannot go on.
    Unsettled(AppError),
}

/// A checkpoint being saved by a task of its own.
struct InFlight {
    /// The sequence number of the last batch in the model it saves.
    seq: i64,
    /// What `rows_since_checkpoint` was when it began, so that it is the rows since it began
    /// that remain when it is done.
    rows: u64,
    task: JoinHandle<AppResult<()>>,
}

/// A checkpoint that could not be saved, and when.
struct Failure {
    /// What `rows_since_checkpoint` was.
    rows: u64,
    at: Instant,
}

/// The task that owns a model.
struct Actor {
    model_id: Uuid,
    db: PgPool,
    model: Arc<Model>,
    /// The sequence number of the last batch in the model.
    seq: i64,
    /// The sequence number of the last batch in the stored checkpoint.
    checkpointed_seq: i64,
    /// The change-log rows since the stored checkpoint, and since the one being saved if there
    /// is one: those it does not hold.
    rows_since_checkpoint: u64,
    in_flight: Option<InFlight>,
    last_failure: Option<Failure>,
    published: watch::Sender<Published>,
    events: broadcast::Sender<ModelEvent>,
    /// The rows that pass the filters of the views read lately, which a batch makes out of date.
    passing: Arc<PassingCache>,
}

/// What the actor wakes up for.
enum Event {
    Request(Option<Request>),
    /// The checkpoint being saved is done.
    Saved(Option<Saved>),
}

/// A checkpoint that is done, and how it went.
type Saved = (InFlight, Result<AppResult<()>, JoinError>);

impl Actor {
    async fn run(self, mailbox: mpsc::Receiver<Request>) {
        let passing = Arc::clone(&self.passing);
        self.serve(mailbox).await;
        // However the actor ended, the model is not in memory any more.
        passing.forget();
    }

    async fn serve(mut self, mut mailbox: mpsc::Receiver<Request>) {
        loop {
            let event = tokio::select! {
                request = mailbox.recv() => Event::Request(request),
                saved = Self::saved(&mut self.in_flight), if self.in_flight.is_some() => {
                    Event::Saved(saved)
                }
            };
            match event {
                Event::Saved(saved) => self.checkpoint_settled(saved),
                // Every handle is gone and the registry too: the process is going away.
                Event::Request(None) => return,
                Event::Request(Some(Request::Apply {
                    user_id,
                    build,
                    reply,
                })) => match self.apply(user_id, build).await {
                    Applied::Settled(result) => {
                        let stored = result.is_ok();
                        // The caller may have gone away; the batch is applied all the same.
                        let _ = reply.send(result);
                        if stored && self.checkpoint_due() {
                            self.start_checkpoint();
                        }
                    }
                    Applied::Unsettled(error) => {
                        let _ = reply.send(Err(error));
                        return;
                    }
                },
                Event::Request(Some(Request::Stop { checkpoint: true })) => {
                    let saved = Self::saved(&mut self.in_flight).await;
                    self.checkpoint_settled(saved);
                    if self.seq > self.checkpointed_seq {
                        self.start_checkpoint();
                        let saved = Self::saved(&mut self.in_flight).await;
                        self.checkpoint_settled(saved);
                    }
                    return;
                }
                Event::Request(Some(Request::Stop { checkpoint: false })) => {
                    if let Some(in_flight) = self.in_flight.take() {
                        in_flight.task.abort();
                    }
                    return;
                }
            }
        }
    }

    /// Waits for the checkpoint being saved to be done, and takes it out; `None` if there is
    /// none. Dropping this before it is done loses nothing.
    async fn saved(in_flight: &mut Option<InFlight>) -> Option<Saved> {
        let result = (&mut in_flight.as_mut()?.task).await;
        in_flight.take().map(|in_flight| (in_flight, result))
    }

    async fn apply(&mut self, user_id: Uuid, build: Build) -> Applied {
        let engined = match run_engine(&self.model, build).await {
            Ok(Some(engined)) => engined,
            Ok(None) => {
                return Applied::Settled(Ok(ApplyOutcome {
                    seq: self.seq,
                    change_set: ChangeSet {
                        generation: self.model.generation(),
                        changed_line_items: Vec::new(),
                        structure_changed: false,
                    },
                }));
            }
            Err(error) => return Applied::Settled(Err(error)),
        };
        let Engined {
            cmds,
            next,
            change_set,
            previous,
        } = engined;

        // Dropping the transaction on the way out undoes it.
        let mut tx = match self.db.begin().await {
            Ok(tx) => tx,
            Err(error) => return Applied::Settled(Err(error.into())),
        };
        let appended =
            match engine_store::append(&mut tx, self.model_id, Some(user_id), &cmds, &previous)
                .await
            {
                Ok(appended) => appended,
                Err(error) => return Applied::Settled(Err(error)),
            };
        if let Err(error) = tx.commit().await {
            return Applied::Unsettled(error.into());
        }

        let seq = appended.seq;
        self.model = Arc::new(next);
        self.seq = seq;
        self.rows_since_checkpoint += appended.rows;
        // The snapshot comes first, so that a subscriber told of the batch finds it in the model.
        self.published.send_replace(Published {
            model: Arc::clone(&self.model),
            seq,
        });
        // Rows found in the model before the batch are let go of now, not at the next view.
        self.passing.invalidate(seq);
        let event = if change_set.structure_changed {
            ModelEvent::StructureChanged { seq }
        } else {
            ModelEvent::CellsChanged {
                seq,
                line_item_ids: change_set.changed_line_items.clone(),
                user_id,
            }
        };
        // Nobody following the model is not an error.
        let _ = self.events.send(event);
        Applied::Settled(Ok(ApplyOutcome { seq, change_set }))
    }

    /// Whether a checkpoint should be saved now: enough rows have piled up and none is being
    /// saved, and if the last one failed, a thousand more rows or five minutes have passed.
    fn checkpoint_due(&self) -> bool {
        self.in_flight.is_none()
            && self.rows_since_checkpoint >= CHECKPOINT_AFTER_ROWS
            && self.last_failure.as_ref().is_none_or(|failure| {
                self.rows_since_checkpoint >= failure.rows + RETRY_AFTER_ROWS
                    || failure.at.elapsed() >= RETRY_AFTER
            })
    }

    /// Has the model as it is now saved as a checkpoint by a task of its own, which holds the
    /// published model and so does not hold up the batches that come next. Not while another
    /// is being saved.
    fn start_checkpoint(&mut self) {
        let (db, model_id, model, seq) = (
            self.db.clone(),
            self.model_id,
            Arc::clone(&self.model),
            self.seq,
        );
        self.in_flight = Some(InFlight {
            seq,
            rows: self.rows_since_checkpoint,
            task: tokio::spawn(async move {
                engine_store::checkpoint(&db, model_id, &model, seq).await
            }),
        });
    }

    /// Takes in how a checkpoint went. A checkpoint only shortens the next load, since the change
    /// log has every batch, so a failure is logged and the next try comes later.
    fn checkpoint_settled(&mut self, saved: Option<Saved>) {
        let Some((in_flight, result)) = saved else {
            return;
        };
        match result {
            Ok(Ok(())) => {
                self.checkpointed_seq = self.checkpointed_seq.max(in_flight.seq);
                self.rows_since_checkpoint =
                    self.rows_since_checkpoint.saturating_sub(in_flight.rows);
                self.last_failure = None;
                return;
            }
            Ok(Err(AppError::NotFound)) => {
                tracing::debug!(model_id = %self.model_id, "the model is gone, so it is not checkpointed");
            }
            Ok(Err(error)) => {
                tracing::warn!(model_id = %self.model_id, %error, "failed to checkpoint the model");
            }
            Err(error) => {
                tracing::error!(model_id = %self.model_id, %error, "failed to checkpoint the model");
            }
        }
        self.last_failure = Some(Failure {
            rows: self.rows_since_checkpoint,
            at: Instant::now(),
        });
    }
}

/// A batch run on a clone of the model.
struct Engined {
    cmds: Vec<Command>,
    next: Model,
    change_set: ChangeSet,
    /// The value each edited cell had before, one for every edit.
    previous: Vec<Value>,
}

/// Makes the commands from `model` and applies them to a clone of it, on a thread that may
/// block: a large batch keeps the engine busy for a while. `None` when there are no commands.
async fn run_engine(model: &Arc<Model>, build: Build) -> AppResult<Option<Engined>> {
    let before = Arc::clone(model);
    tokio::task::spawn_blocking(move || {
        let cmds = build(&before)?;
        if cmds.is_empty() {
            return Ok(None);
        }
        let mut next = Model::clone(&before);
        let change_set = next.apply_batch(cmds.clone())?;
        let previous = previous_values(&before, &cmds);
        Ok::<_, AppError>(Some(Engined {
            cmds,
            next,
            change_set,
            previous,
        }))
    })
    .await
    .map_err(|error| AppError::Internal(error.into()))?
}

/// The value each cell that `cmds` set has in `model`, one for every edit, in order. A cell that
/// `model` does not have because the batch creates its line item or one of its items reads as
/// the blank of the kind of value it is given.
pub fn previous_values(model: &Model, cmds: &[Command]) -> Vec<Value> {
    let mut previous = Vec::new();
    for cmd in cmds {
        let Command::SetCells { line_item, edits } = cmd else {
            continue;
        };
        let coords: Vec<Vec<CoordToken>> = edits.iter().map(|edit| edit.coords.clone()).collect();
        match model.read_cells(*line_item, &coords) {
            Ok(values) => previous.extend(values),
            Err(_) => previous.extend(coords.iter().zip(edits).map(|(coords, edit)| {
                model
                    .read_cells(*line_item, std::slice::from_ref(coords))
                    .ok()
                    .and_then(|values| values.into_iter().next())
                    .unwrap_or_else(|| blank_like(&edit.value))
            })),
        }
    }
    previous
}

fn blank_like(value: &Value) -> Value {
    match value {
        Value::Number(_) => Value::Number(0.0),
        Value::Boolean(_) => Value::Boolean(false),
        Value::Text(_) => Value::Text("".into()),
        Value::Date(_) => Value::Date(None),
        Value::Item(_) => Value::Item(None),
        Value::Period(_) => Value::Period(None),
    }
}

/// A running actor: the way to reach it and the task to wait for.
struct Running {
    handle: ModelHandle,
    task: JoinHandle<()>,
}

impl Running {
    /// Loads the model and starts its actor.
    async fn start(
        db: &PgPool,
        model_id: Uuid,
        event_buffer: usize,
        passing: Arc<PassingStore>,
    ) -> AppResult<Running> {
        let (model, seq) = engine_store::load(db, model_id).await?;
        let (checkpointed_seq, rows_since_checkpoint) =
            engine_store::batches_since_checkpoint(db, model_id).await?;
        let model = Arc::new(model);
        let (published, snapshots) = watch::channel(Published {
            model: Arc::clone(&model),
            seq,
        });
        let (events, _) = broadcast::channel(event_buffer);
        let passing = Arc::new(PassingCache::new(model_id, passing));
        let (mailbox, requests) = mpsc::channel(MAILBOX_SIZE);
        let handle = ModelHandle {
            model_id,
            mailbox,
            published: snapshots,
            events: events.downgrade(),
            last_used: Arc::new(Mutex::new(Instant::now())),
            passing: Arc::clone(&passing),
        };
        let actor = Actor {
            model_id,
            db: db.clone(),
            model,
            seq,
            checkpointed_seq,
            rows_since_checkpoint,
            in_flight: None,
            last_failure: None,
            published,
            events,
            passing,
        };
        Ok(Running {
            handle,
            task: tokio::spawn(actor.run(requests)),
        })
    }

    /// Stops the actor after the requests it has, saving a checkpoint of the model first if
    /// asked to and the model changed since the last one. Returns when the actor is gone and its
    /// events channel closed.
    async fn stop(self, checkpoint: bool) {
        // When the actor is gone already there is nobody to tell, and its task ends at once.
        let _ = self.handle.mailbox.send(Request::Stop { checkpoint }).await;
        if let Err(error) = self.task.await {
            tracing::error!(model_id = %self.handle.model_id, %error, "the actor of the model failed");
        }
    }
}

/// What a model's slot holds: its actor, if it is loaded. The lock on the slot is held while the
/// model is loaded and while its actor is stopped, so that nobody loads a model that another
/// actor still owns.
type Slot = tokio::sync::Mutex<Option<Running>>;

/// Which actors to stop.
#[derive(Clone, Copy)]
enum Pick {
    /// Those whose model was not used for this long and has no subscribers, and those that
    /// stopped by themselves.
    Idle(Duration),
    All,
}

struct Registry {
    db: PgPool,
    idle: Duration,
    /// How many events a slow subscriber of a model may fall behind by.
    event_buffer: usize,
    /// The rows that pass the filters of the views of every model, within one budget.
    passing: Arc<PassingStore>,
    slots: Mutex<HashMap<Uuid, Arc<Slot>>>,
    /// Lets as many actors save their last checkpoint at once as half the connections of the
    /// pool, so that unloading many models does not make the batches that go on wait for one.
    stopping: Arc<Semaphore>,
}

/// The actors of the models in use, started when a model is first asked for.
#[derive(Clone)]
pub struct ModelRegistry {
    inner: Arc<Registry>,
}

impl ModelRegistry {
    /// A registry over the models in `db`, which unloads a model once it is `idle` unused.
    pub fn new(db: PgPool, idle: Duration) -> ModelRegistry {
        ModelRegistry::with_event_buffer(db, idle, EVENT_BUFFER)
    }

    /// [`ModelRegistry::new`], with subscribers that may fall behind by `event_buffer` events
    /// before they miss some, which a test makes small.
    pub fn with_event_buffer(db: PgPool, idle: Duration, event_buffer: usize) -> ModelRegistry {
        let stopping = (db.options().get_max_connections() / 2).max(1) as usize;
        ModelRegistry {
            inner: Arc::new(Registry {
                db,
                idle,
                event_buffer,
                passing: Arc::new(PassingStore::new(view_cache::BUDGET)),
                slots: Mutex::new(HashMap::new()),
                stopping: Arc::new(Semaphore::new(stopping)),
            }),
        }
    }

    /// The handle of a model's actor, which is started, with the model loaded, if it is not
    /// running. Callers that ask for a model that is not loaded yet at the same time wait for
    /// one load. A model that does not exist is `NotFound`.
    pub async fn get(&self, model_id: Uuid) -> AppResult<ModelHandle> {
        let slot = Arc::clone(self.slots().entry(model_id).or_default());
        let mut running = slot.lock().await;
        if let Some(running) = running.as_ref().filter(|r| !r.handle.is_stopped()) {
            running.handle.touch();
            return Ok(running.handle.clone());
        }
        // Either nothing is loaded or the actor stopped on its own; the database has the truth.
        let started = Running::start(
            &self.inner.db,
            model_id,
            self.inner.event_buffer,
            Arc::clone(&self.inner.passing),
        )
        .await?;
        let handle = started.handle.clone();
        *running = Some(started);
        Ok(handle)
    }

    /// Saves and unloads the models that nobody has used for the idle time and that nobody
    /// follows. Their handles stop working and their events channels close.
    pub async fn evict_idle(&self) {
        self.stop_actors(Pick::Idle(self.inner.idle)).await;
    }

    /// Saves and unloads every model, for when the server shuts down.
    pub async fn shutdown(&self) {
        self.stop_actors(Pick::All).await;
    }

    /// Unloads a model that was deleted, without saving it, and closes its events channel. A
    /// later `get` finds the model gone. It is done even if the caller does not wait for it.
    pub async fn discard(&self, model_id: Uuid) {
        self.discard_many(vec![model_id]).await;
    }

    /// Unloads models that were deleted together, as `discard` does for one. They are discarded
    /// one after another by a single task, which is finished even if the caller does not wait.
    pub async fn discard_many(&self, model_ids: Vec<Uuid>) {
        let registry = self.clone();
        let discarding = tokio::spawn(async move {
            for model_id in model_ids {
                registry.discard_now(model_id).await;
            }
        });
        if let Err(error) = discarding.await {
            tracing::error!(%error, "failed to discard the models");
        }
    }

    async fn discard_now(&self, model_id: Uuid) {
        let slot = self.slots().get(&model_id).cloned();
        let Some(slot) = slot else {
            return;
        };
        let mut running = slot.lock().await;
        if let Some(running) = running.take() {
            running.stop(false).await;
        }
    }

    fn slots(&self) -> MutexGuard<'_, HashMap<Uuid, Arc<Slot>>> {
        self.inner
            .slots
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    async fn stop_actors(&self, pick: Pick) {
        let slots: Vec<Arc<Slot>> = {
            let mut slots = self.slots();
            // Nobody holds a slot that only the map does, so one that is empty is a model that
            // failed to load or was discarded.
            slots.retain(|_, slot| {
                Arc::strong_count(slot) > 1 || slot.try_lock().map_or(true, |held| held.is_some())
            });
            slots.values().cloned().collect()
        };
        let mut stopping = JoinSet::new();
        for slot in slots {
            let mut running = match pick {
                Pick::All => slot.lock_owned().await,
                // A slot that is locked is being loaded, used or stopped, so it is not idle.
                Pick::Idle(_) => match slot.try_lock_owned() {
                    Ok(running) => running,
                    Err(_) => continue,
                },
            };
            let picked = running.as_ref().is_some_and(|actor| match pick {
                Pick::Idle(idle) => {
                    actor.handle.is_stopped()
                        || (actor.handle.idle_for() >= idle && actor.handle.subscribers() == 0)
                }
                Pick::All => true,
            });
            if !picked {
                continue;
            }
            // The slot stays locked until the actor is gone.
            let permits = Arc::clone(&self.inner.stopping);
            stopping.spawn(async move {
                let _permit = permits.acquire_owned().await;
                if let Some(running) = running.take() {
                    running.stop(true).await;
                }
            });
        }
        while let Some(stopped) = stopping.join_next().await {
            if let Err(error) = stopped {
                tracing::error!(%error, "failed to stop a model");
            }
        }
    }
}

/// Unloads the models that are not used any more once a minute, for as long as the process
/// runs.
pub async fn evict_idle_periodically(models: ModelRegistry) {
    let mut ticker = tokio::time::interval(EVICTION_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        models.evict_idle().await;
    }
}
