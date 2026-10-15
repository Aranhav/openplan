-- What a model is made of once it is saved: its structure as one document, the cells typed into
-- input line items as opaque chunks, and the change log that is replayed over the last checkpoint.
-- Every table enables row level security (see 0002).
ALTER TABLE models ADD COLUMN checkpoint_seq bigint NOT NULL DEFAULT 0;

CREATE TABLE model_structure (
  model_id uuid PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  doc jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE model_structure ENABLE ROW LEVEL SECURITY;

CREATE TABLE line_item_data (
  model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  line_item_id uuid NOT NULL, chunk int NOT NULL, data bytea NOT NULL,
  PRIMARY KEY (model_id, line_item_id, chunk));
ALTER TABLE line_item_data ENABLE ROW LEVEL SECURITY;

-- A batch of commands is one row of kind 'cells' or 'structure'; each edited cell also gets a row
-- of kind 'cell' that only records its old and new value. Loading a model replays the batches
-- after its checkpoint and never reads the cell rows, which are far more numerous, so they are
-- left out of the replay index; the history of a cell reads only them, newest first, which the
-- last column of its index serves. Both indexes are partial, so the foreign keys have indexes of
-- their own: without them deleting a model, or a user, reads the whole log.
CREATE TABLE change_log (
  seq bigserial PRIMARY KEY,
  model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL, payload jsonb NOT NULL, line_item_id uuid, cell_key text);
CREATE INDEX change_log_replay_idx ON change_log (model_id, seq) WHERE kind <> 'cell';
CREATE INDEX change_log_cell_idx ON change_log (model_id, line_item_id, cell_key, seq)
  WHERE kind = 'cell';
CREATE INDEX change_log_model_idx ON change_log (model_id);
CREATE INDEX change_log_user_idx ON change_log (user_id);
ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;
