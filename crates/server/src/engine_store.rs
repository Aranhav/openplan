//! Saving and loading the calculation engine's model (spec §6).
//!
//! A model is stored as three things: its structure as one JSON document (`model_structure`),
//! the cells typed into its input line items as opaque chunks (`line_item_data`) and a log of
//! the batches of commands applied since the last checkpoint (`change_log`). A checkpoint
//! replaces the first two and moves `models.checkpoint_seq` up to the last change they include;
//! loading reads the checkpoint and applies the changes after it.

use anyhow::{Context, anyhow};
use openplan_engine::{
    Calendar, CellEdit, Command, CoordToken, InputChunk, LineItemId, Model, StructureDoc, Value,
};
use serde::Serialize;
use sqlx::{PgExecutor, PgPool, Postgres, Transaction, types::Json};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::Calendar as ApiCalendar,
};

/// What `load` reads of a model, in one consistent snapshot of the database.
struct Stored {
    checkpoint_seq: i64,
    doc: StructureDoc,
    chunks: Vec<InputChunk>,
    /// The batches applied since the checkpoint, oldest first, with their sequence numbers.
    batches: Vec<(i64, Vec<Command>)>,
}

/// The key of a cell in the change log: its coordinates, an item id or a period label for
/// each axis of its line item, joined by `|`.
pub fn cell_key(tokens: &[CoordToken]) -> String {
    tokens
        .iter()
        .map(|token| match token {
            CoordToken::Item(id) => id.0.to_string(),
            CoordToken::Period(label) => label.clone(),
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// A foreign key violation means the model does not exist (any more).
fn map_store_error(err: sqlx::Error) -> AppError {
    match err {
        sqlx::Error::Database(db_err) if db_err.is_foreign_key_violation() => AppError::NotFound,
        other => other.into(),
    }
}

/// Gives a new model the state it starts from: no lists or modules, `calendar` and the
/// engine's default versions. Keeps the state the model already has.
pub async fn create_model_state(
    db: impl PgExecutor<'_>,
    model_id: Uuid,
    calendar: Calendar,
) -> AppResult<()> {
    let doc = Model::new(calendar).export_structure();
    sqlx::query(
        "INSERT INTO model_structure (model_id, doc) VALUES ($1, $2)
         ON CONFLICT (model_id) DO NOTHING",
    )
    .bind(model_id)
    .bind(Json(&doc))
    .execute(db)
    .await
    .map_err(map_store_error)?;
    Ok(())
}

/// Gives a model that was created before its state was stored the state a new model gets,
/// from the calendar it was created with.
async fn ensure_state(db: &PgPool, model_id: Uuid) -> AppResult<()> {
    let calendar = sqlx::query_scalar::<_, Json<ApiCalendar>>(
        "SELECT calendar FROM models m
         WHERE m.id = $1 AND NOT EXISTS (SELECT 1 FROM model_structure s WHERE s.model_id = m.id)",
    )
    .bind(model_id)
    .fetch_optional(db)
    .await?;
    match calendar {
        Some(Json(calendar)) => create_model_state(db, model_id, calendar.into()).await,
        None => Ok(()),
    }
}

async fn read_stored(db: &PgPool, model_id: Uuid) -> AppResult<Stored> {
    let mut tx = db.begin().await?;
    // A checkpoint can commit between the reads below; one snapshot keeps them consistent.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let (checkpoint_seq, Json(doc)) = sqlx::query_as::<_, (i64, Json<StructureDoc>)>(
        "SELECT m.checkpoint_seq, s.doc
         FROM models m JOIN model_structure s ON s.model_id = m.id
         WHERE m.id = $1",
    )
    .bind(model_id)
    .fetch_one(&mut *tx)
    .await?;
    let rows = sqlx::query_as::<_, (Uuid, i32, Vec<u8>)>(
        "SELECT line_item_id, chunk, data FROM line_item_data
         WHERE model_id = $1 ORDER BY line_item_id, chunk",
    )
    .bind(model_id)
    .fetch_all(&mut *tx)
    .await?;
    let batches = sqlx::query_as::<_, (i64, Json<Vec<Command>>)>(
        "SELECT seq, payload FROM change_log
         WHERE model_id = $1 AND seq > $2 AND kind IN ('cells', 'structure')
         ORDER BY seq",
    )
    .bind(model_id)
    .bind(checkpoint_seq)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    let chunks = rows
        .into_iter()
        .map(|(line_item, chunk, data)| {
            Ok(InputChunk {
                line_item: LineItemId(line_item),
                chunk: u32::try_from(chunk).context("a stored chunk has a negative number")?,
                data,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(Stored {
        checkpoint_seq,
        doc,
        chunks,
        batches: batches
            .into_iter()
            .map(|(seq, Json(cmds))| (seq, cmds))
            .collect(),
    })
}

/// Builds the model of the checkpoint and applies the batches after it.
fn rebuild(stored: Stored) -> anyhow::Result<Model> {
    let mut model = Model::from_parts(stored.doc, stored.chunks)
        .context("the stored structure and cells do not make a model")?;
    for (seq, cmds) in stored.batches {
        model
            .apply_batch(cmds)
            .with_context(|| format!("change {seq} cannot be applied again"))?;
    }
    Ok(model)
}

/// Loads a model: its last checkpoint with the changes made since replayed over it. Returns
/// the model and the sequence number of its last change, which is the checkpoint's when
/// nothing was changed since.
///
/// A model created before its state was stored gets the state of a new model first.
pub async fn load(db: &PgPool, model_id: Uuid) -> AppResult<(Model, i64)> {
    ensure_state(db, model_id).await?;
    let stored = read_stored(db, model_id).await?;
    let last_seq = stored
        .batches
        .last()
        .map_or(stored.checkpoint_seq, |&(seq, _)| seq);
    let model = tokio::task::spawn_blocking(move || rebuild(stored))
        .await
        .map_err(|err| AppError::Internal(err.into()))?
        .map_err(|err| {
            AppError::Internal(err.context(format!("failed to load model {model_id}")))
        })?;
    if model.load_warnings() > 0 {
        tracing::warn!(
            %model_id,
            left_out = model.load_warnings(),
            "stored cells that lie outside the model's structure were left out"
        );
    }
    Ok((model, last_seq))
}

/// The cells that `cmds` write, with the line item of each, in the order they are written.
fn edited_cells(cmds: &[Command]) -> impl Iterator<Item = (LineItemId, &CellEdit)> {
    cmds.iter()
        .filter_map(|cmd| match cmd {
            Command::SetCells { line_item, edits } => Some((*line_item, edits)),
            _ => None,
        })
        .flat_map(|(line_item, edits)| edits.iter().map(move |edit| (line_item, edit)))
}

/// What the change log keeps of an edit: the value the cell had and the value it was given.
#[derive(Serialize)]
struct CellChange<'a> {
    old: &'a Value,
    new: &'a Value,
}

/// Records a batch of commands that was applied to the model, in the caller's transaction, and
/// returns its sequence number. The batch is one row of kind `cells` when it only sets cells
/// and of kind `structure` otherwise, and each cell it sets also gets a row of kind `cell`
/// with the old and the new value, for the history of the cell.
///
/// `previous` holds the value each edited cell had before the batch, one for every `CellEdit`
/// of the `SetCells` commands, in the order they appear.
///
/// The model's row is locked until the transaction ends, so the sequence numbers of one
/// model's batches follow the order they commit in.
pub async fn append(
    tx: &mut Transaction<'_, Postgres>,
    model_id: Uuid,
    user_id: Option<Uuid>,
    cmds: &[Command],
    previous: &[Value],
) -> AppResult<i64> {
    let edited: Vec<(LineItemId, &CellEdit)> = edited_cells(cmds).collect();
    if edited.len() != previous.len() {
        return Err(AppError::Internal(anyhow!(
            "the batch edits {} cells but {} old values were given",
            edited.len(),
            previous.len()
        )));
    }
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM models WHERE id = $1 FOR NO KEY UPDATE")
        .bind(model_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::NotFound)?;

    let kind = if cmds
        .iter()
        .all(|cmd| matches!(cmd, Command::SetCells { .. }))
    {
        "cells"
    } else {
        "structure"
    };
    let seq = sqlx::query_scalar::<_, i64>(
        "INSERT INTO change_log (model_id, user_id, kind, payload)
         VALUES ($1, $2, $3, $4) RETURNING seq",
    )
    .bind(model_id)
    .bind(user_id)
    .bind(kind)
    .bind(Json(cmds))
    .fetch_one(&mut **tx)
    .await?;

    if !edited.is_empty() {
        let mut line_items = Vec::with_capacity(edited.len());
        let mut keys = Vec::with_capacity(edited.len());
        let mut changes = Vec::with_capacity(edited.len());
        for (&(line_item, edit), old) in edited.iter().zip(previous) {
            line_items.push(line_item.0);
            keys.push(cell_key(&edit.coords));
            changes.push(Json(CellChange {
                old,
                new: &edit.value,
            }));
        }
        sqlx::query(
            "INSERT INTO change_log (model_id, user_id, kind, payload, line_item_id, cell_key)
             SELECT $1, $2, 'cell', c.payload, c.line_item_id, c.cell_key
             FROM UNNEST($3, $4, $5) AS c(line_item_id, cell_key, payload)",
        )
        .bind(model_id)
        .bind(user_id)
        .bind(line_items)
        .bind(keys)
        .bind(changes)
        .execute(&mut **tx)
        .await?;
    }
    Ok(seq)
}

/// Saves the model as the checkpoint at `upto_seq`, the sequence number of the last change it
/// includes: its structure replaces the stored one, its input cells replace every stored chunk
/// and the model's `checkpoint_seq` becomes `upto_seq`, all in one transaction.
///
/// `model` must hold exactly the changes up to `upto_seq`: take the snapshot between commands,
/// only after the append of the batch numbered `upto_seq` has committed. A snapshot that lags
/// behind `upto_seq` makes every later `load` replay changes the stored structure already has,
/// and one that runs ahead of it replays them twice.
///
/// A checkpoint older than the stored one (`upto_seq` below the model's `checkpoint_seq`) is
/// dropped and returns `Ok`: the stored checkpoint stays as it is.
pub async fn checkpoint(
    db: &PgPool,
    model_id: Uuid,
    model: &Model,
    upto_seq: i64,
) -> AppResult<()> {
    let snapshot = model.clone();
    let (doc, chunks) = tokio::task::spawn_blocking(move || {
        (snapshot.export_structure(), snapshot.export_inputs())
    })
    .await
    .map_err(|err| AppError::Internal(err.into()))?;

    let mut tx = db.begin().await?;
    // The model row first. Deleting a model locks its row and then the rows that refer to it, so
    // taking the row first, in the mode the foreign keys of the writes below would, keeps the
    // two from waiting on each other. It does not hold up `append` or an update of the model.
    sqlx::query_scalar::<_, i32>("SELECT 1 FROM models WHERE id = $1 FOR KEY SHARE")
        .bind(model_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?;
    sqlx::query(
        "INSERT INTO model_structure (model_id, doc) VALUES ($1, $2)
         ON CONFLICT (model_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
    )
    .bind(model_id)
    .bind(Json(&doc))
    .execute(&mut *tx)
    .await
    .map_err(map_store_error)?;
    sqlx::query("DELETE FROM line_item_data WHERE model_id = $1")
        .bind(model_id)
        .execute(&mut *tx)
        .await
        .map_err(map_store_error)?;
    if !chunks.is_empty() {
        let mut line_items = Vec::with_capacity(chunks.len());
        let mut numbers = Vec::with_capacity(chunks.len());
        let mut data = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            line_items.push(chunk.line_item.0);
            numbers
                .push(i32::try_from(chunk.chunk).context("a chunk number does not fit the table")?);
            data.push(chunk.data);
        }
        sqlx::query(
            "INSERT INTO line_item_data (model_id, line_item_id, chunk, data)
             SELECT $1, c.line_item_id, c.chunk, c.data
             FROM UNNEST($2, $3, $4) AS c(line_item_id, chunk, data)",
        )
        .bind(model_id)
        .bind(line_items)
        .bind(numbers)
        .bind(data)
        .execute(&mut *tx)
        .await
        .map_err(map_store_error)?;
    }
    // Last, so that the lock this takes on the model is held no longer than it takes to commit
    // and edits are not held up while the chunks are written.
    let updated =
        sqlx::query("UPDATE models SET checkpoint_seq = $2 WHERE id = $1 AND checkpoint_seq <= $2")
            .bind(model_id)
            .bind(upto_seq)
            .execute(&mut *tx)
            .await?;
    if updated.rows_affected() == 0 {
        tracing::warn!(
            %model_id,
            upto_seq,
            "a checkpoint older than the stored one was dropped"
        );
        tx.rollback().await?;
        return Ok(());
    }
    tx.commit().await?;
    Ok(())
}
