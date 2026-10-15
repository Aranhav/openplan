-- Supabase exposes the public schema through its Data API, so every table there needs row level
-- security. No policies are defined: the server connects as the table owner, which bypasses it.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE models ENABLE ROW LEVEL SECURITY;
ALTER TABLE _sqlx_migrations ENABLE ROW LEVEL SECURITY;
