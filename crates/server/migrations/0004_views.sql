-- The saved views of a module: a name and the definition of a grid, as it was sent. A read checks
-- a definition against the module's structure as it is then (see views_api), so the definition is
-- stored as given and never rewritten. A view names its module by id only and has no foreign key to
-- it, since modules are part of the model's structure document. Deleting a module deletes its views
-- in the same handler (modules_api::delete_module), and so does deleting a list, for the views of
-- its properties module (structure_api::delete_list); deleting the model cascades. Every table
-- enables row level security (see 0002).
CREATE TABLE views (
  id uuid PRIMARY KEY,
  model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  module_id uuid NOT NULL,
  name text NOT NULL,
  definition jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX views_module_name_key ON views (module_id, lower(name));
CREATE UNIQUE INDEX views_module_default_key ON views (module_id) WHERE is_default;
-- The foreign keys have indexes of their own, so that deleting a model or a user does not read
-- every view.
CREATE INDEX views_model_idx ON views (model_id);
CREATE INDEX views_created_by_idx ON views (created_by);
ALTER TABLE views ENABLE ROW LEVEL SECURITY;
