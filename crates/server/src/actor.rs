//! The models held in memory, one actor each (spec §4).
//!
//! A model is loaded from the database when it is first used and then owned by an actor, a task
//! that applies the batches of commands sent to it one at a time. A batch is applied to a clone
//! of the model, stored in the change log and only then becomes the model: whatever fails on the
//! way leaves the model as it was. After each batch the actor publishes the new model for
//! readers, which never wait for it, and tells the subscribers what changed. Once enough changes
//! have piled up in the log, and when the actor stops, it saves a checkpoint of the model.
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
    sync::{broadcast, mpsc, oneshot, watch},
    task::{JoinHandle, JoinSet},
    time::MissedTickBehavior,
};
use uuid::Uuid;

use crate::{
    engine_store,
    error::{AppError, AppResult},
};

/// How many change-log rows, batches and the cells they set, pile up before an actor saves a
/// checkpoint of its model.
const CHECKPOINT_AFTER_ROWS: u64 = 10_000;
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

#[derive(Debug)]
enum Request {
    Apply {
        user_id: Uuid,
        cmds: Vec<Command>,
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
}

impl ModelHandle {
    /// Applies the commands as one batch, all or nothing, on behalf of `user_id`.
    ///
    /// A batch the engine rejects fails with [`AppError::Engine`], and one that cannot be stored
    /// with `Internal` (`NotFound` when the model is gone); either way nothing was changed. An
    /// empty batch changes nothing and is not stored.
    pub async fn apply(&self, user_id: Uuid, cmds: Vec<Command>) -> AppResult<ApplyOutcome> {
        self.touch();
        let (reply, outcome) = oneshot::channel();
        self.mailbox
            .send(Request::Apply {
                user_id,
                cmds,
                reply,
            })
            .await
            .map_err(|_| self.stopped())?;
        outcome.await.map_err(|_| self.stopped())?
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

    /// Follows the batches applied from now on. The channel closes when the actor stops, so
    /// that a subscriber waiting for the next event finds out; one that falls too far behind
    /// misses events and must read the snapshot again.
    pub fn subscribe(&self) -> broadcast::Receiver<ModelEvent> {
        match self.events.upgrade() {
            Some(events) => events.subscribe(),
            None => broadcast::channel(1).1,
        }
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

/// The task that owns a model.
struct Actor {
    model_id: Uuid,
    db: PgPool,
    model: Arc<Model>,
    /// The sequence number of the last batch in the model.
    seq: i64,
    /// The sequence number of the last batch in the stored checkpoint.
    checkpointed_seq: i64,
    rows_since_checkpoint: u64,
    published: watch::Sender<Published>,
    events: broadcast::Sender<ModelEvent>,
}

impl Actor {
    async fn run(mut self, mut mailbox: mpsc::Receiver<Request>) {
        while let Some(request) = mailbox.recv().await {
            match request {
                Request::Apply {
                    user_id,
                    cmds,
                    reply,
                } => match self.apply(user_id, cmds).await {
                    Applied::Settled(result) => {
                        let stored = result.is_ok();
                        // The caller may have gone away; the batch is applied all the same.
                        let _ = reply.send(result);
                        if stored && self.rows_since_checkpoint >= CHECKPOINT_AFTER_ROWS {
                            self.checkpoint().await;
                        }
                    }
                    Applied::Unsettled(error) => {
                        let _ = reply.send(Err(error));
                        return;
                    }
                },
                Request::Stop { checkpoint } => {
                    if checkpoint && self.seq > self.checkpointed_seq {
                        self.checkpoint().await;
                    }
                    return;
                }
            }
        }
    }

    async fn apply(&mut self, user_id: Uuid, cmds: Vec<Command>) -> Applied {
        if cmds.is_empty() {
            return Applied::Settled(Ok(ApplyOutcome {
                seq: self.seq,
                change_set: ChangeSet {
                    generation: self.model.generation(),
                    changed_line_items: Vec::new(),
                    structure_changed: false,
                },
            }));
        }
        let cmds = Arc::new(cmds);
        let (next, change_set, previous) = match run_engine(&self.model, &cmds).await {
            Ok(applied) => applied,
            Err(error) => return Applied::Settled(Err(error)),
        };

        // Dropping the transaction on the way out undoes it.
        let mut tx = match self.db.begin().await {
            Ok(tx) => tx,
            Err(error) => return Applied::Settled(Err(error.into())),
        };
        let seq =
            match engine_store::append(&mut tx, self.model_id, Some(user_id), &cmds, &previous)
                .await
            {
                Ok(seq) => seq,
                Err(error) => return Applied::Settled(Err(error)),
            };
        if let Err(error) = tx.commit().await {
            return Applied::Unsettled(error.into());
        }

        self.model = Arc::new(next);
        self.seq = seq;
        self.rows_since_checkpoint += 1 + previous.len() as u64;
        // The snapshot comes first, so that a subscriber told of the batch finds it in the model.
        self.published.send_replace(Published {
            model: Arc::clone(&self.model),
            seq,
        });
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

    /// Saves the model. A checkpoint only shortens the next load, since the change log has every
    /// batch, so a failure is logged and tried again with the next one.
    async fn checkpoint(&mut self) {
        match engine_store::checkpoint(&self.db, self.model_id, &self.model, self.seq).await {
            Ok(()) => {
                self.checkpointed_seq = self.seq;
                self.rows_since_checkpoint = 0;
            }
            Err(AppError::NotFound) => {
                tracing::debug!(model_id = %self.model_id, "the model is gone, so it is not checkpointed");
            }
            Err(error) => {
                tracing::warn!(model_id = %self.model_id, %error, "failed to checkpoint the model");
            }
        }
    }
}

/// Applies the commands to a clone of `model`, on a thread that may block: a large batch keeps
/// the engine busy for a while. Returns the changed model, what it changed and the value each
/// edited cell had before.
async fn run_engine(
    model: &Arc<Model>,
    cmds: &Arc<Vec<Command>>,
) -> AppResult<(Model, ChangeSet, Vec<Value>)> {
    let (before, cmds) = (Arc::clone(model), Arc::clone(cmds));
    tokio::task::spawn_blocking(move || {
        let mut next = Model::clone(&before);
        let change_set = next.apply_batch(Vec::clone(&cmds))?;
        let previous = previous_values(&before, &cmds);
        Ok::<_, AppError>((next, change_set, previous))
    })
    .await
    .map_err(|error| AppError::Internal(error.into()))?
}

/// The value each cell that `cmds` set has in `model`, one for every edit, in order. A cell that
/// `model` does not have because the batch creates its line item or one of its items reads as
/// the blank of the kind of value it is given.
fn previous_values(model: &Model, cmds: &[Command]) -> Vec<Value> {
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
    async fn start(db: &PgPool, model_id: Uuid) -> AppResult<Running> {
        let (model, seq) = engine_store::load(db, model_id).await?;
        let (checkpointed_seq, rows_since_checkpoint) = checkpoint_progress(db, model_id).await?;
        let model = Arc::new(model);
        let (published, snapshots) = watch::channel(Published {
            model: Arc::clone(&model),
            seq,
        });
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        let (mailbox, requests) = mpsc::channel(MAILBOX_SIZE);
        let handle = ModelHandle {
            model_id,
            mailbox,
            published: snapshots,
            events: events.downgrade(),
            last_used: Arc::new(Mutex::new(Instant::now())),
        };
        let actor = Actor {
            model_id,
            db: db.clone(),
            model,
            seq,
            checkpointed_seq,
            rows_since_checkpoint,
            published,
            events,
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

/// The sequence number of the last batch in the stored checkpoint of a model, and how many
/// change-log rows come after it.
async fn checkpoint_progress(db: &PgPool, model_id: Uuid) -> AppResult<(i64, u64)> {
    let (checkpoint_seq, rows) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT m.checkpoint_seq,
                (SELECT count(*) FROM change_log c
                 WHERE c.model_id = m.id AND c.seq > m.checkpoint_seq)
         FROM models m WHERE m.id = $1",
    )
    .bind(model_id)
    .fetch_one(db)
    .await?;
    Ok((checkpoint_seq, rows.unsigned_abs()))
}

/// What a model's slot holds: its actor, if it is loaded. The lock on the slot is held while the
/// model is loaded and while its actor is stopped, so that nobody loads a model that another
/// actor still owns.
type Slot = tokio::sync::Mutex<Option<Running>>;

/// Which actors to stop.
#[derive(Clone, Copy)]
enum Pick {
    /// Those whose model was not used for this long, and those that stopped by themselves.
    Idle(Duration),
    All,
}

struct Registry {
    db: PgPool,
    idle: Duration,
    slots: Mutex<HashMap<Uuid, Arc<Slot>>>,
}

/// The actors of the models in use, started when a model is first asked for.
#[derive(Clone)]
pub struct ModelRegistry {
    inner: Arc<Registry>,
}

impl ModelRegistry {
    /// A registry over the models in `db`, which unloads a model once it is `idle` unused.
    pub fn new(db: PgPool, idle: Duration) -> ModelRegistry {
        ModelRegistry {
            inner: Arc::new(Registry {
                db,
                idle,
                slots: Mutex::new(HashMap::new()),
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
        let started = Running::start(&self.inner.db, model_id).await?;
        let handle = started.handle.clone();
        *running = Some(started);
        Ok(handle)
    }

    /// Saves and unloads the models that nobody has used for the idle time. Their handles stop
    /// working and their events channels close.
    pub async fn evict_idle(&self) {
        self.stop_actors(Pick::Idle(self.inner.idle)).await;
    }

    /// Saves and unloads every model, for when the server shuts down.
    pub async fn shutdown(&self) {
        self.stop_actors(Pick::All).await;
    }

    /// Unloads a model that was deleted, without saving it, and closes its events channel. A
    /// later `get` finds the model gone.
    pub async fn discard(&self, model_id: Uuid) {
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
                Pick::Idle(idle) => actor.handle.is_stopped() || actor.handle.idle_for() >= idle,
                Pick::All => true,
            });
            if !picked {
                continue;
            }
            // The slot stays locked until the actor is gone.
            stopping.spawn(async move {
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
