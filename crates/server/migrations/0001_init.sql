CREATE TABLE users (
  id uuid PRIMARY KEY, email text NOT NULL, name text NOT NULL, password_hash text,
  is_instance_admin boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE TABLE sessions (
  id_hash bytea PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), user_agent text);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','builder','planner','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id, user_id));
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);
CREATE TABLE models (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, description text NOT NULL DEFAULT '',
  mode text NOT NULL DEFAULT 'dev' CHECK (mode IN ('dev','prod')),
  calendar jsonb NOT NULL, created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX models_workspace_name_key ON models (workspace_id, lower(name));
