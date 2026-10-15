# M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable OpenPlan skeleton: Rust server with auth, users, workspaces and models; React + shadcn app shell with setup, login, home, members, users and model settings screens; Docker, CI and Playwright E2E.

**Architecture:** Cargo workspace with one binary crate `crates/server` (axum + sqlx/Postgres). Vite SPA in `web/`, served by the server via `rust-embed` in release and via Vite proxy in development. Typed TS client generated from the server's OpenAPI document. E2E tests in `e2e/` drive the real server.

**Tech Stack:** Rust 1.97 (edition 2024), axum 0.8, sqlx 0.8, utoipa 5, Postgres 16/17; Node 22, pnpm 10, React 19, Vite, Tailwind v4, shadcn/ui, TanStack Router + Query, openapi-fetch, Vitest, Playwright 1.56.1.

**Spec:** `docs/superpowers/specs/2026-10-15-openplan-design.md` (sections 2, 6, 7, 8.1, 9.1, 9.13, 12, 13, 15-M1).

## Environment (already prepared on the dev machine)

- Postgres 16 running on `localhost:5432`, user `postgres`, password `postgres`.
- Dev DB URL: `postgres://postgres:postgres@localhost:5432/openplan_dev`. Server tests use `sqlx::test`, which creates throwaway databases from `DATABASE_URL`, so export `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres` when running `cargo test`.
- Playwright browsers are preinstalled at `/opt/pw-browsers` (chromium-1194). Never run `playwright install` locally.
- Docker daemon may be unavailable locally; the Docker build is verified in CI.

## Global Constraints

- Rust edition 2024. `cargo fmt --all` clean and `cargo clippy --all-targets -- -D warnings` clean.
- Crates (use newest compatible patch versions): `axum 0.8`, `axum-extra` (cookie feature, version compatible with axum 0.8), `tokio 1` (full), `sqlx 0.8` (features `runtime-tokio`, `tls-rustls`, `postgres`, `uuid`, `chrono`, `json`, `migrate`, `macros`), `tower-http 0.6` (`trace`, `request-id`, `util`), `tower 0.5`, `utoipa 5` (`axum_extras`, `uuid`, `chrono`), `utoipa-scalar` (axum feature, compatible with utoipa 5), `argon2 0.5`, `rust-embed 8`, `mime_guess 2`, `uuid 1` (`v7`, `serde`), `chrono 0.4` (`serde`), `serde 1`, `serde_json 1`, `thiserror 2`, `anyhow 1`, `tracing 0.1`, `tracing-subscriber 0.3` (`env-filter`), `rand 0.9`, `sha2 0.10`, `base64 0.22`, `clap 4` (`derive`).
- SQL: use `sqlx::query`/`sqlx::query_as::<_, T>` with `#[derive(sqlx::FromRow)]`. Do **not** use `query!`/`query_as!` macros (no DB needed at compile time). Migrations embedded with `sqlx::migrate!("./migrations")`.
- JSON fields are `snake_case`. Timestamps RFC 3339 UTC (`chrono::DateTime<Utc>`). IDs are UUID v7 generated in Rust (`Uuid::now_v7()`).
- All API routes live under `/api/v1` except `GET /api/health`, `GET /api/openapi.json`, `GET /api/docs`.
- Errors are `application/problem+json`: `{"type":"about:blank","title":..,"status":..,"code":..,"detail":..,"errors":[{"field":..,"message":..}]?}`. Stable codes used in M1: `auth.unauthenticated` 401, `auth.invalid_credentials` 401, `auth.forbidden` 403, `auth.csrf` 403, `auth.rate_limited` 429, `setup.already_done` 409, `validation` 422, `not_found` 404, `user.email_taken` 409, `user.not_found` 404, `workspace.last_admin` 409, `workspace.member_exists` 409, `model.name_taken` 409, `internal` 500.
- Validation limits: email trimmed + lowercased, must contain one `@` with non-empty parts, ≤ 254 chars; person name trimmed 1–100 chars; password 10–256 chars; workspace and model names trimmed 1–80 chars; model description ≤ 500 chars.
- Frontend: TypeScript strict; Tailwind v4 via `@tailwindcss/vite`; shadcn/ui style `new-york`, base color `neutral`, CSS variables; icons from `lucide-react`. Any UI element that exists in shadcn/ui must use that component. Never edit files in `web/src/components/ui/` by hand except via the shadcn CLI.
- UX rules: every mutation button is disabled and shows `Loader2` spinner while pending; forms use react-hook-form + zod + shadcn `Form` with inline field errors; success and failure feedback via `sonner` toasts; every data view has a `Skeleton` loading state, an empty state (icon, one sentence, primary action) and an error state (`Alert variant="destructive"` with Retry). Copy is sentence case; buttons start with a verb.
- Code hygiene: no commented-out code, no unused code, no TODO placeholders.
- Commits: conventional commit subject; every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01B4fbtKwEE5W6o1rLKT3yFn
  ```

## Review Focus

1. Two first-run setup requests arriving at once (double-click, two tabs) → exactly one admin is created; the other gets 409 `setup.already_done`. Pinned in Task 3.
2. Email case and whitespace (`" Admin@Acme.COM "`) → login works against `admin@acme.com`; creating a user whose email differs only in case → 409 `user.email_taken`. Pinned in Tasks 3 and 4.
3. A user who is not a member requests a workspace, its members or a model by id → 404 `not_found` (never 403, so existence does not leak). Pinned in Tasks 5 and 6.
4. Removing or demoting the last admin of a workspace → 409 `workspace.last_admin`. Pinned in Task 5.
5. A user disabled while holding a live session → next request 401, and logging in again returns the same `auth.invalid_credentials` as a wrong password. Pinned in Task 4.

---

## File Structure

```
Cargo.toml                         workspace (members = ["crates/server"])
rustfmt.toml                       edition = "2024"
LICENSE                            AGPL-3.0 full text
README.md                          overview, quick start, development
CLAUDE.md                          conventions for contributors and agents
.gitignore
crates/server/
  Cargo.toml                       package openplan-server, bin "openplan"
  migrations/0001_init.sql
  src/main.rs                      CLI: serve | openapi
  src/lib.rs                       pub mod declarations
  src/config.rs                    Config::from_env
  src/app.rs                       AppState, build_router
  src/error.rs                     AppError, FieldError, AppResult
  src/db.rs                        connect, MIGRATOR
  src/openapi.rs                   ApiDoc
  src/static_files.rs              SPA serving via rust-embed
  src/validate.rs                  shared validators
  src/auth/mod.rs                  CurrentUser extractor, cookie names
  src/auth/password.rs             argon2 hash/verify
  src/auth/session.rs              create/lookup/delete sessions
  src/auth/csrf.rs                 CSRF middleware
  src/auth/rate_limit.rs           LoginLimiter
  src/auth/routes.rs               setup, login, logout, me
  src/users.rs                     instance-admin user management
  src/authz.rs                     WorkspaceRole, require_workspace_role
  src/workspaces.rs                workspaces + members routes
  src/models.rs                    models routes
  tests/common/mod.rs              TestApp helper
  tests/health.rs, tests/auth.rs, tests/users.rs, tests/workspaces.rs, tests/models.rs
web/                               Vite app (see Task 7)
e2e/                               Playwright (see Task 12)
pnpm-workspace.yaml                packages: web, e2e
compose.yml
docker/Dockerfile
.dockerignore
.github/workflows/ci.yml
```

---

### Task 1: Workspace and server skeleton (Sonnet)

**Files:**
- Create: `Cargo.toml`, `rustfmt.toml`, `.gitignore`, `LICENSE`, `CLAUDE.md`, `crates/server/Cargo.toml`, `crates/server/src/{main.rs,lib.rs,config.rs,app.rs,error.rs,openapi.rs,static_files.rs}`
- Test: `crates/server/tests/health.rs`, unit tests in `error.rs`, `config.rs`

**Interfaces:**
- Produces:
  - `pub struct Config { pub database_url: String, pub public_url: String, pub bind: std::net::SocketAddr, pub log: String }`; `impl Config { pub fn from_env() -> anyhow::Result<Config>; pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Config>; pub fn secure_cookies(&self) -> bool }` — `secure_cookies` is true when `public_url` starts with `https://`. Env names per spec §2.4 (`DATABASE_URL`, `OPENPLAN_PUBLIC_URL`, `OPENPLAN_BIND` default `0.0.0.0:8080`, `OPENPLAN_LOG` default `info`). Missing required var → error naming the variable.
  - `pub struct FieldError { pub field: String, pub message: String }` (Serialize, ToSchema)
  - `pub enum AppError { Unauthenticated, InvalidCredentials, Forbidden, Csrf, RateLimited { retry_after_secs: u64 }, NotFound, Conflict { code: &'static str, detail: String }, CodedNotFound { code: &'static str, detail: String }, Validation(Vec<FieldError>), Internal(anyhow::Error) }` with `impl IntoResponse` (problem+json per Global Constraints; `RateLimited` adds `Retry-After` header; `Internal` logs with `tracing::error!` and returns generic detail "Something went wrong."), `impl From<sqlx::Error>` (`RowNotFound` → `NotFound`, else `Internal`), `impl From<anyhow::Error>` → `Internal`.
  - `pub type AppResult<T> = Result<T, AppError>;`
  - `#[derive(Clone)] pub struct AppState { pub db: sqlx::PgPool, pub config: std::sync::Arc<Config> }` with `pub fn new(db: PgPool, config: Config) -> AppState`; `main`, tests and `TestApp` always construct state through `AppState::new` (Task 3 adds `login_limiter` inside it).
  - `pub fn build_router(state: AppState) -> axum::Router` — mounts `GET /api/health` → `{"status":"ok","version":env!("CARGO_PKG_VERSION")}`, `GET /api/openapi.json`, `GET /api/docs` (Scalar), nests `/api/v1` (empty router this task), adds `SetRequestIdLayer` (UUID v7, header `x-request-id`) + `PropagateRequestIdLayer` + `TraceLayer`, and falls back to `static_files::serve`.
  - `#[derive(OpenApi)] pub struct ApiDoc;` in `openapi.rs` with `pub fn openapi_json() -> String` (pretty JSON). Later tasks add their paths/schemas to `ApiDoc`.
  - `static_files::serve(uri: Uri) -> Response`: `#[derive(RustEmbed)] #[folder = "../../web/dist"] #[allow_missing = true]`; exact asset match returns it with `mime_guess` content type and `Cache-Control: public, max-age=31536000, immutable` for paths under `assets/`; any other non-`/api` path returns `index.html` (`Cache-Control: no-cache`); if `index.html` is missing return 404 text "Web UI not built. Run `pnpm --dir web build`."; paths under `/api` return 404 problem+json `not_found`.
  - `main.rs` CLI (clap): `openplan serve` (default when no subcommand) loads Config, inits tracing, connects DB, runs migrations (Task 2), binds and serves with graceful shutdown on Ctrl-C/SIGTERM; `openplan openapi` prints `openapi_json()` to stdout without needing env or DB.

- [ ] **Step 1: Write failing tests**
  - `tests/health.rs::health_returns_ok`: `build_router` with a lazily-connected pool (`PgPoolOptions::new().connect_lazy("postgres://invalid")`) → `GET /api/health` → 200, body `status == "ok"`, header `x-request-id` present.
  - `tests/health.rs::unknown_api_path_is_problem_json`: `GET /api/v1/nope` → 404, `content-type` starts with `application/problem+json`, body `code == "not_found"`.
  - `tests/health.rs::openapi_json_served`: `GET /api/openapi.json` → 200 and body has `"openapi"` key.
  - `error.rs` unit: `validation_error_lists_fields` → status 422, `code == "validation"`, `errors[0].field == "name"`; `rate_limited_sets_retry_after` → 429 and `Retry-After: 30`.
  - `config.rs` unit: `missing_database_url_is_error` (message contains `DATABASE_URL`); `defaults_applied` (bind `0.0.0.0:8080`, log `info`); `secure_cookies_for_https` true for `https://plan.acme.com`, false for `http://localhost:8080`.
- [ ] **Step 2: Run `cargo test -p openplan-server` → fails to compile / tests fail.**
- [ ] **Step 3: Implement the files per Interfaces.** `LICENSE` = verbatim AGPL-3.0 text from `https://www.gnu.org/licenses/agpl-3.0.txt`. `.gitignore`: `target/`, `node_modules/`, `web/dist/`, `e2e/test-results/`, `e2e/playwright-report/`, `e2e/screenshots/`, `.env`. `CLAUDE.md`: project one-liner, layout, the commands from Tasks 1/2/7/12, and the Global Constraints bullets (copy them).
- [ ] **Step 4: Run `cargo test -p openplan-server`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all --check` → all pass. Run `cargo run -p openplan-server -- openapi | head -3` → JSON.**
- [ ] **Step 5: Commit** `feat(server): workspace skeleton with health, errors, openapi and SPA serving`

### Task 2: Database schema and test harness (Haiku)

**Files:**
- Create: `crates/server/migrations/0001_init.sql`, `crates/server/src/db.rs`, `crates/server/tests/common/mod.rs`
- Modify: `crates/server/src/main.rs` (run migrations on serve), `crates/server/src/lib.rs`

**Interfaces:**
- Consumes: `AppState`, `build_router`, `Config` (Task 1).
- Produces:
  - `pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");` and `pub async fn connect(url: &str) -> anyhow::Result<PgPool>` (max 10 connections) in `db.rs`.
  - Schema (exact):
    ```sql
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
    ```
  - `tests/common/mod.rs`: `pub struct TestApp { pub router: Router, pub db: PgPool, cookies: HashMap<String,String> }` with `pub fn new(db: PgPool) -> TestApp` (config `public_url = "http://localhost:8080"`), `pub async fn request(&mut self, method: Method, path: &str, body: Option<serde_json::Value>) -> TestResponse` which stores `Set-Cookie` values, sends stored cookies, and automatically sends `x-openplan-csrf` equal to the stored `op_csrf` cookie on non-GET requests; `pub async fn request_without_csrf(..)` same but omits the header; `pub struct TestResponse { pub status: StatusCode, pub headers: HeaderMap, pub json: serde_json::Value }`; convenience `get/post/patch/delete`. Each test uses `#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]`.

- [ ] **Step 1: Write failing test** `tests/health.rs::migrations_create_tables` (sqlx::test): query `SELECT count(*) FROM information_schema.tables WHERE table_name IN ('users','sessions','workspaces','workspace_members','models')` → 5.
- [ ] **Step 2: Run** `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres cargo test -p openplan-server migrations_create_tables` → FAIL.
- [ ] **Step 3: Implement** migration, `db.rs`, migrations in `serve` (`MIGRATOR.run(&pool)` before binding), `TestApp`.
- [ ] **Step 4: Run all server tests + clippy + fmt** → PASS.
- [ ] **Step 5: Commit** `feat(server): initial schema, migrations and test harness`

### Task 3: Authentication core (Sonnet)

**Files:**
- Create: `crates/server/src/auth/{mod.rs,password.rs,session.rs,csrf.rs,rate_limit.rs,routes.rs}`, `crates/server/src/validate.rs`, `crates/server/tests/auth.rs`
- Modify: `app.rs` (state + routes + CSRF layer), `openapi.rs`, `lib.rs`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `validate.rs`: `pub fn email(raw: &str) -> Result<String, FieldError>` (returns normalized), `pub fn person_name(raw: &str) -> Result<String, FieldError>`, `pub fn password(raw: &str) -> Result<(), FieldError>`, `pub fn entity_name(field: &str, raw: &str) -> Result<String, FieldError>` (1–80), `pub fn collect(results: Vec<Result<(), FieldError>>) -> AppResult<()>` helper returning `Validation` with all failures.
  - `password.rs`: `pub fn hash_password(plain: &str) -> AppResult<String>` (argon2id default params, run inside `tokio::task::spawn_blocking` by callers via `pub async fn hash_password_async`), `pub fn verify_password(plain: &str, hash: &str) -> bool`, `pub async fn verify_password_async(plain: String, hash: Option<String>) -> bool` (when `hash` is `None` still runs a verify against a fixed dummy hash so timing is equal).
  - `session.rs`: constants `SESSION_TTL_DAYS = 14`, `SESSION_RENEW_BELOW_DAYS = 7`; `pub async fn create(db: &PgPool, user_id: Uuid, user_agent: Option<&str>) -> AppResult<String>` returns raw token (32 random bytes, base64url no pad) and stores `sha256(raw)`; `pub async fn lookup(db: &PgPool, raw: &str) -> AppResult<Option<Uuid>>` returns user id if not expired, extending `expires_at` to now+14d when fewer than 7 days remain; `pub async fn delete(db: &PgPool, raw: &str) -> AppResult<()>`; `pub async fn delete_all_for_user(db: &PgPool, user_id: Uuid) -> AppResult<()>`.
  - `auth/mod.rs`: `pub const SESSION_COOKIE: &str = "op_session"; pub const CSRF_COOKIE: &str = "op_csrf"; pub const CSRF_HEADER: &str = "x-openplan-csrf";` `#[derive(Clone, Serialize, ToSchema, FromRow)] pub struct CurrentUser { pub id: Uuid, pub email: String, pub name: String, pub is_instance_admin: bool }` implementing `FromRequestParts<AppState>`: reads `op_session`, `session::lookup`, loads user; missing/expired session or `disabled = true` → `AppError::Unauthenticated`. `pub fn session_cookies(token: &str, secure: bool) -> (Cookie<'static>, Cookie<'static>)` building `op_session` (HttpOnly, SameSite=Lax, Path=/, Max-Age 14d, Secure if `secure`) and `op_csrf` (random 32 bytes base64url, NOT HttpOnly, same other attributes); `pub fn clear_cookies(secure: bool) -> (Cookie, Cookie)`.
  - `csrf.rs`: `pub async fn require_csrf(req: Request, next: Next) -> Response` — for methods other than GET/HEAD/OPTIONS, if the request carries an `op_session` cookie then header `x-openplan-csrf` must equal cookie `op_csrf`, else `AppError::Csrf`. Requests without `op_session` pass through.
  - `rate_limit.rs`: `pub struct LoginLimiter` with `pub fn new(max_failures: u32, window: Duration) -> Self`, `pub fn check(&self, key: &str) -> Result<(), u64>` (Err = seconds until retry), `pub fn record_failure(&self, key: &str)`, `pub fn reset(&self, key: &str)`. In-memory `Mutex<HashMap<String, Vec<Instant>>>`. Production instance: 10 failures / 15 min, key = `"{email}|{ip}"` (ip from `ConnectInfo<SocketAddr>` when present, else `"unknown"`). `serve` must use `into_make_service_with_connect_info::<SocketAddr>()`.
  - `AppState` gains `pub login_limiter: Arc<LoginLimiter>`, initialized in `AppState::new` (10 failures / 15 min).
  - Routes (all under `/api/v1`, documented with `#[utoipa::path]`, tag `auth`):
    - `GET /setup/status` → `{"needs_setup": bool}` (true when `users` is empty).
    - `POST /setup` body `{email, name, password, workspace_name}` → 201 `{"user": CurrentUser, "workspace": {"id","name"}}` + session cookies. In one transaction: `SELECT pg_advisory_xact_lock(4242)`, if any user exists → 409 `setup.already_done`; insert user (`is_instance_admin = true`), workspace, membership role `admin`.
    - `POST /auth/login` body `{email, password}` → 200 `{"user": CurrentUser}` + cookies. Limiter check first (429 `auth.rate_limited`). Unknown email, wrong password, disabled user, or null `password_hash` → 401 `auth.invalid_credentials` (identical body) and `record_failure`; success → `reset`.
    - `POST /auth/logout` → 204, deletes session, clears cookies (works even when session already invalid).
    - `GET /auth/me` → 200 `{"user": CurrentUser, "workspaces": [{"id","name","role"}]}` ordered by workspace name; instance admins see all workspaces with role `admin`.

- [ ] **Step 1: Write failing tests** in `tests/auth.rs` (each `#[sqlx::test]`, using `TestApp`):
  - `setup_status_true_on_empty_db`, `setup_creates_admin_workspace_and_session` (then `GET /auth/me` → 200, workspaces has 1 entry with role `admin`), `setup_twice_conflicts` (second → 409 `setup.already_done`), `concurrent_setup_creates_one_admin` (two `TestApp`s sharing the pool fire `POST /setup` via `tokio::join!` → statuses are {201, 409}; `SELECT count(*) FROM users` = 1), `setup_validation_errors` (bad email + short password → 422 with `errors` fields `email` and `password`).
  - `login_with_mixed_case_email` (setup with `admin@acme.com`, login with `" Admin@Acme.COM "` → 200), `login_wrong_password_401`, `login_unknown_email_same_error` (body equals wrong-password body), `login_rate_limited_after_10_failures` (11th attempt → 429, `Retry-After` header present), `logout_invalidates_session` (me → 401 after logout), `me_requires_session` (401 `auth.unauthenticated`).
  - `csrf_required_for_cookie_mutations`: after login, `request_without_csrf(POST /auth/logout)` → 403 `auth.csrf`; with header → 204.
  - `expired_session_rejected`: set `expires_at = now() - interval '1 minute'` in DB → me → 401.
  - `session_renewed_when_near_expiry`: set `expires_at = now() + interval '1 day'` → me → 200 and DB `expires_at > now() + interval '13 days'`.
  - Unit (`password.rs`): `hash_then_verify`, `verify_rejects_wrong`.
- [ ] **Step 2: Run tests → FAIL.**
- [ ] **Step 3: Implement per Interfaces.**
- [ ] **Step 4: Run all server tests + clippy + fmt → PASS.**
- [ ] **Step 5: Commit** `feat(server): first-run setup, password login, sessions, CSRF and rate limiting`

### Task 4: Users and profile (Haiku)

**Files:**
- Create: `crates/server/src/users.rs`, `crates/server/tests/users.rs`
- Modify: `app.rs`, `openapi.rs`, `lib.rs`

**Interfaces:**
- Consumes: `CurrentUser`, `validate::*`, `password::*`, `session::delete_all_for_user`, `TestApp` (Tasks 2–3).
- Produces (`/api/v1`, tag `users`):
  - `#[derive(Serialize, ToSchema, FromRow)] pub struct UserDto { id, email, name, is_instance_admin, disabled, created_at }`.
  - `GET /users` (instance admin) → `[UserDto]` ordered by name. Non-admin → 403 `auth.forbidden`.
  - `POST /users` (instance admin) body `{email, name, password, is_instance_admin}` → 201 `UserDto`; duplicate email (case-insensitive) → 409 `user.email_taken`.
  - `PATCH /users/{id}` (instance admin) body `{name?, is_instance_admin?, disabled?, password?}` → 200 `UserDto`. Setting `disabled = true` or `password` deletes all that user's sessions. An admin cannot disable themself or remove their own admin flag → 422 field `disabled` / `is_instance_admin` with message "You can't change this for your own account.".
  - `PATCH /auth/me` body `{name}` → 200 `CurrentUser`.
  - `POST /auth/me/password` body `{current_password, new_password}` → 204; wrong current → 422 field `current_password` "Current password is incorrect."; deletes the user's other sessions (keeps current).
- [ ] **Step 1: Write failing tests** `tests/users.rs`: `admin_creates_and_lists_users`, `non_admin_forbidden` (create planner via API, login as planner, `GET /users` → 403), `duplicate_email_case_insensitive` (`Pat@Acme.com` after `pat@acme.com` → 409 `user.email_taken`), `disable_user_kills_session_and_login` (planner logged in on second `TestApp`; admin disables → planner `GET /auth/me` → 401; planner login → 401 `auth.invalid_credentials`), `admin_cannot_disable_self` (422), `update_own_name`, `change_password_requires_current` (wrong → 422; right → 204; login with new password → 200).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all server tests + clippy + fmt → PASS.**
- [ ] **Step 5: Commit** `feat(server): user administration and profile endpoints`

### Task 5: Workspaces, members and authorization (Sonnet)

**Files:**
- Create: `crates/server/src/authz.rs`, `crates/server/src/workspaces.rs`, `crates/server/tests/workspaces.rs`
- Modify: `app.rs`, `openapi.rs`, `lib.rs`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `authz.rs`: `#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ToSchema, sqlx::Type)] #[serde(rename_all = "lowercase")] pub enum WorkspaceRole { Viewer, Planner, Builder, Admin }` (ordering Viewer < Planner < Builder < Admin; stored as lowercase text); `pub async fn workspace_role(db: &PgPool, user: &CurrentUser, workspace_id: Uuid) -> AppResult<WorkspaceRole>` — instance admin → `Admin` if the workspace exists; member → their role; otherwise → `AppError::NotFound`; `pub async fn require_workspace_role(db, user, workspace_id, min: WorkspaceRole) -> AppResult<WorkspaceRole>` — `NotFound` for non-members, `Forbidden` when role < min.
  - Routes (`/api/v1`, tag `workspaces`):
    - `GET /workspaces` → `[{id, name, role}]` (same rule as `/auth/me`).
    - `POST /workspaces` (instance admin) `{name}` → 201 `{id, name, role:"admin"}`; creator added as `admin` member.
    - `PATCH /workspaces/{id}` (workspace admin) `{name}` → 200.
    - `DELETE /workspaces/{id}` (instance admin) → 204 (cascades).
    - `GET /workspaces/{id}/members` (any member) → `[{user_id, email, name, role}]` ordered by name.
    - `POST /workspaces/{id}/members` (workspace admin) `{email, role}` → 201 member; unknown email → 404 `user.not_found` detail "No user with that email. Ask an instance admin to create the account."; already member → 409 `workspace.member_exists`.
    - `PATCH /workspaces/{id}/members/{user_id}` (workspace admin) `{role}` → 200.
    - `DELETE /workspaces/{id}/members/{user_id}` (workspace admin) → 204.
    - Removing or demoting the last `admin` member → 409 `workspace.last_admin` detail "A workspace needs at least one admin.". Check inside a transaction with `SELECT ... FOR UPDATE` on the workspace's member rows.
- [ ] **Step 1: Write failing tests** `tests/workspaces.rs`: `admin_creates_workspace_and_is_admin_member`, `non_instance_admin_cannot_create_workspace` (403), `member_lists_members`, `non_member_gets_404_for_workspace_and_members`, `add_member_by_email` (case-insensitive), `add_unknown_email_404_user_not_found`, `add_existing_member_409`, `planner_cannot_add_members` (403), `cannot_remove_last_admin` (409 `workspace.last_admin`), `cannot_demote_last_admin` (409), `can_demote_admin_when_another_exists`, `rename_requires_workspace_admin`, `delete_workspace_cascades_members`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all server tests + clippy + fmt → PASS.**
- [ ] **Step 5: Commit** `feat(server): workspaces, members and role checks`

### Task 6: Models (Haiku)

**Files:**
- Create: `crates/server/src/models.rs`, `crates/server/tests/models.rs`
- Modify: `app.rs`, `openapi.rs`, `lib.rs`

**Interfaces:**
- Consumes: `require_workspace_role`, `WorkspaceRole`, `validate::*`, `TestApp`.
- Produces (`/api/v1`, tag `models`):
  - `#[derive(Serialize, Deserialize, ToSchema)] pub struct Calendar { pub fiscal_year_start_month: u8, pub first_year: i32, pub years: u8 }` — default for new models: `{1, <current UTC year>, 3}`.
  - `#[derive(Serialize, ToSchema)] pub struct ModelDto { id, workspace_id, name, description, mode: "dev"|"prod", calendar: Calendar, created_by: Option<Uuid>, created_at, updated_at }` (mode as `#[serde(rename_all="lowercase")] enum ModelMode { Dev, Prod }`).
  - `GET /workspaces/{id}/models` (any member) → `[ModelDto]` ordered by `updated_at DESC`.
  - `POST /workspaces/{id}/models` (builder+) `{name, description?}` → 201; duplicate name in workspace (case-insensitive) → 409 `model.name_taken` detail "A model with this name already exists in this workspace.".
  - `GET /models/{id}` → `ModelDto` (role ≥ viewer in its workspace; non-member → 404).
  - `PATCH /models/{id}` (builder+) `{name?, description?, mode?}` → 200; bumps `updated_at`.
  - `DELETE /models/{id}` (builder+) → 204.
- [ ] **Step 1: Write failing tests** `tests/models.rs`: `builder_creates_model_with_default_calendar` (years 3, start month 1), `planner_cannot_create_model` (403), `viewer_can_list_and_get`, `non_member_404_on_get_model`, `duplicate_name_case_insensitive_409`, `same_name_allowed_in_other_workspace`, `patch_updates_fields_and_timestamp`, `invalid_name_422` (empty after trim, 81 chars), `description_too_long_422`, `delete_model`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all server tests + clippy + fmt → PASS.**
- [ ] **Step 5: Commit** `feat(server): model CRUD within workspaces`

### Task 7: Web scaffold and typed API client (Sonnet)

**Files:**
- Create: `pnpm-workspace.yaml`, `web/` (Vite React TS app), `web/components.json`, `web/src/{main.tsx,index.css,router.tsx}`, `web/src/routes/__root.tsx`, `web/src/components/theme-provider.tsx`, `web/src/lib/utils.ts`, `web/src/lib/api/{client.ts,schema.d.ts,keys.ts}`, `web/src/lib/api/client.test.ts`, `web/eslint.config.js`, `web/vitest.config.ts` (or inside `vite.config.ts`), `web/src/test/setup.ts`
- Modify: `CLAUDE.md` (web commands)

**Interfaces:**
- Produces:
  - `web/package.json` scripts: `dev` (vite, port 5173, proxy `/api` → `http://localhost:8080` with `ws: true`), `build` (`tsc -b && vite build`), `lint` (eslint), `typecheck` (`tsc -b --noEmit` or `tsc --noEmit -p tsconfig.app.json`), `test` (`vitest run`), `gen:api` (`cargo run -q -p openplan-server -- openapi > openapi.json && openapi-typescript openapi.json -o src/lib/api/schema.d.ts && rm openapi.json`).
  - Path alias `@/*` → `src/*`. TanStack Router file-based routing via `@tanstack/router-plugin/vite` (generated `src/routeTree.gen.ts`, committed). Router context type `{ queryClient: QueryClient }`.
  - shadcn initialized (new-york, neutral, CSS variables) and these components added: `sidebar breadcrumb button card dialog alert-dialog dropdown-menu input label form select badge command sonner skeleton avatar alert tabs table separator tooltip popover sheet switch textarea checkbox`.
  - `ThemeProvider` + `useTheme()` (`"light"|"dark"|"system"`, storage key `openplan-theme`, toggles `dark` class on `<html>`), per shadcn Vite dark-mode docs.
  - `client.ts`: `export const api = createClient<paths>({ baseUrl: "/api/v1" })` with middleware that adds header `x-openplan-csrf` from cookie `op_csrf` on non-GET requests. `export class ApiError extends Error { status: number; code: string; detail: string; errors: { field: string; message: string }[] }`. `export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T>` — throws `ApiError` built from problem+json (fallback code `internal`, detail "Something went wrong."), returns `undefined as T` for 204.
  - `keys.ts`: `export const queryKeys = { setupStatus: ["setup-status"], me: ["me"], workspaces: ["workspaces"], members: (id: string) => ["workspaces", id, "members"], models: (wsId: string) => ["workspaces", wsId, "models"], model: (id: string) => ["models", id], users: ["users"] } as const`.
  - `main.tsx`: `QueryClient` (queries `retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2`, `staleTime: 30_000`), `RouterProvider`, `ThemeProvider`, `<Toaster richColors closeButton />`.
- [ ] **Step 1: Write failing test** `client.test.ts`: `unwrap throws ApiError with code and field errors` (mock response 422 problem+json → error `.code === "validation"`, `.errors[0].field === "name"`); `unwrap returns data on 200`; `csrf header added on POST` (set `document.cookie = "op_csrf=abc"`, stub `fetch`, call `api.POST("/auth/logout")`, assert request header `x-openplan-csrf === "abc"`).
- [ ] **Step 2: Run** `pnpm --dir web test` → FAIL.
- [ ] **Step 3: Scaffold and implement** (`pnpm create vite web --template react-ts`, then add deps; `pnpm dlx shadcn@latest init` / `add`). Root route renders `<Outlet />` only. Run `pnpm --dir web gen:api`.
- [ ] **Step 4: Run** `pnpm install`, `pnpm --dir web lint`, `pnpm --dir web typecheck`, `pnpm --dir web test`, `pnpm --dir web build` → all pass; `cargo build -p openplan-server` then `curl localhost:8080/` with server running serves the built `index.html`.
- [ ] **Step 5: Commit** `feat(web): vite + shadcn scaffold with typed API client`

### Task 8: Setup, login and route guards (Sonnet)

**Files:**
- Create: `web/src/routes/setup.tsx`, `web/src/routes/login.tsx`, `web/src/routes/_app.tsx`, `web/src/features/auth/{api.ts,setup-form.tsx,login-form.tsx,setup-form.test.tsx,login-form.test.tsx}`, `web/src/components/auth-layout.tsx`

**Interfaces:**
- Consumes: `api`, `unwrap`, `ApiError`, `queryKeys` (Task 7).
- Produces:
  - `features/auth/api.ts`: `setupStatusQuery`, `meQuery` (`queryOptions` objects), hooks `useMe()`, `useSetup()`, `useLogin()`, `useLogout()` (logout clears the whole query cache and navigates to `/login`).
  - `_app.tsx` `beforeLoad`: `ensureQueryData(setupStatusQuery)` → if `needs_setup` redirect `/setup`; `ensureQueryData(meQuery)` → on 401 redirect `/login?redirect=<current href>`. Exposes `me` via route context for children (`context.me`). Renders `<Outlet/>` (shell added in Task 9).
  - `/setup`: redirect to `/login` if setup already done. `AuthLayout` = centered `Card` (max-w-md) with OpenPlan wordmark (lucide `ChartNoAxesCombined` icon + "OpenPlan"). Title "Set up OpenPlan", description "Create the admin account and your first workspace." Fields: "Your name", "Work email", "Password" (description "At least 10 characters."), "Confirm password", "Workspace name" (placeholder "Acme Corp"). zod: confirm must match ("Passwords don't match."). Submit "Create account". On success: set `me` cache, navigate `/`. Server 422 field errors map onto form fields via `form.setError`.
  - `/login`: Title "Sign in", fields "Email", "Password", button "Sign in". On 401 show `Alert variant="destructive"` "Email or password is incorrect."; on 429 "Too many attempts. Try again in N minutes." (N from `Retry-After`, rounded up). On success navigate to `redirect` search param (only if it starts with `/`), else `/`.
- [ ] **Step 1: Write failing tests** (Vitest + Testing Library + `msw` or stubbed `fetch`): `setup form shows mismatch error` (no request sent); `setup form maps server field errors` (422 with field `email` → message under email field); `login shows incorrect-credentials alert on 401`; `login disables button while pending`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run lint, typecheck, test, build → PASS.** Manually: run server (`DATABASE_URL=postgres://postgres:postgres@localhost:5432/openplan_dev cargo run -p openplan-server` after `createdb`) + `pnpm --dir web dev`, walk setup → lands on `/` (blank outlet is fine this task).
- [ ] **Step 5: Commit** `feat(web): first-run setup, sign in and route guards`

### Task 9: App shell, workspace switcher, command palette (Sonnet)

**Files:**
- Create: `web/src/components/{app-sidebar.tsx,workspace-switcher.tsx,nav-user.tsx,site-header.tsx,command-menu.tsx,empty-state.tsx,error-state.tsx,page-header.tsx}`, `web/src/hooks/use-current-workspace.ts`, `web/src/routes/_app/index.tsx`, `web/src/features/workspaces/api.ts`, `web/src/features/models/api.ts`, `web/src/components/command-menu.test.tsx`
- Modify: `web/src/routes/_app.tsx`

**Interfaces:**
- Consumes: Task 8 (`context.me`, hooks), Task 7.
- Produces:
  - `features/workspaces/api.ts`: `useWorkspaces()`, `useCreateWorkspace()`, `useRenameWorkspace()`, `useMembers(wsId)`, `useAddMember(wsId)`, `useUpdateMember(wsId)`, `useRemoveMember(wsId)`.
  - `features/models/api.ts`: `useModels(wsId)`, `useModel(id)`, `useCreateModel(wsId)`, `useUpdateModel(id)`, `useDeleteModel()`; mutations invalidate `queryKeys.models(wsId)` and `queryKeys.model(id)`.
  - `useCurrentWorkspace(): { workspace: {id,name,role} | undefined, setLastWorkspace(id: string): void }` — resolves from route param `workspaceId`, or from the current model's `workspace_id`, else `localStorage["openplan.lastWorkspace"]`, else first workspace.
  - `EmptyState({ icon, title, description, action? })`, `ErrorState({ error, onRetry })`, `PageHeader({ title, description?, actions? })`.
  - Shell layout in `_app.tsx`: `SidebarProvider` → `AppSidebar` + `SidebarInset` containing `SiteHeader` and `<main className="flex-1 p-4 md:p-6">`.
  - `AppSidebar`: header = `WorkspaceSwitcher` (shadcn "team switcher" pattern: `DropdownMenu` listing workspaces with role badge, plus "Create workspace" item for instance admins opening a `Dialog`); content group "Workspace": Models (`LayoutGrid`) → `/w/$id`, Members (`Users`) → `/w/$id/members`; group "Instance" (instance admins only): Users (`UserCog`) → `/admin/users`; footer = `NavUser` (`Avatar` initials, name, email; `DropdownMenu`: Profile → `/profile`, Theme submenu Light/Dark/System with check on current, Sign out). Active route highlighted via `SidebarMenuButton isActive`. Collapsible to icons (`collapsible="icon"`).
  - `SiteHeader`: `SidebarTrigger`, `Separator`, `Breadcrumb` (Workspace name › current page or model name), right side: search button showing "Search…" + `⌘K` `kbd` that opens `CommandMenu`.
  - `CommandMenu`: `CommandDialog` opened by `⌘K`/`Ctrl+K` or the header button; groups "Go to" (Models, Members, Users if admin, Profile), "Workspaces" (switch), "Models" (current workspace's models → `/m/$id`), "Theme" (Light, Dark, System). Selecting closes the dialog.
  - `/_app/` index: redirect to `/w/$workspaceId` of `useCurrentWorkspace` (if user has no workspaces, show `EmptyState` "You're not in any workspace yet" / "Ask an admin to add you to a workspace.").
- [ ] **Step 1: Write failing test** `command-menu.test.tsx`: `opens with Ctrl+K and lists models`; `selecting a model navigates to /m/<id>` (memory router).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run lint, typecheck, test, build → PASS.**
- [ ] **Step 5: Commit** `feat(web): app shell with sidebar, workspace switcher and command palette`

### Task 10: Models home and model settings screens (Sonnet)

**Files:**
- Create: `web/src/routes/_app/w/$workspaceId/index.tsx`, `web/src/routes/_app/m/$modelId/index.tsx`, `web/src/features/models/{model-card.tsx,create-model-dialog.tsx,rename-model-dialog.tsx,delete-model-dialog.tsx,model-settings-form.tsx,create-model-dialog.test.tsx}`, `web/src/lib/format.ts`

**Interfaces:**
- Consumes: Task 9 hooks/components.
- Produces:
  - `format.ts`: `relativeTime(iso: string, now?: Date): string` via `Intl.RelativeTimeFormat` ("2 hours ago", "just now" under 1 minute).
  - `/w/$workspaceId`: `PageHeader` "Models" / "Planning models in <workspace>." with "New model" button (builder+ only). Responsive grid (`sm:grid-cols-2 xl:grid-cols-3`) of `ModelCard`: `Card` with name (`CardTitle`), description (`line-clamp-2`, muted; "No description" when empty), `Badge` "Dev"/"Production" (`variant` secondary/default), footer "Updated <relative>". Whole card is a link to `/m/$id`; a `DropdownMenu` (`MoreHorizontal` icon button, stops propagation) with Rename and Delete (builder+). Loading: 6 card skeletons. Empty: icon `Boxes`, "No models yet", "Create a model to start planning.", action "New model" (builder+) . Error: `ErrorState`.
  - `CreateModelDialog`: fields Name (required, ≤80), Description (`Textarea`, optional, ≤500); submit "Create model"; on success toast "Model created" and navigate to `/m/$id`; 409 `model.name_taken` shown under Name.
  - `RenameModelDialog`, `DeleteModelDialog` (`AlertDialog`: "Delete <name>?" / "This permanently deletes the model and all its data. This can't be undone." / buttons "Cancel", destructive "Delete model").
  - `/m/$modelId`: breadcrumb Workspace › Model. `PageHeader` with model name + mode `Badge`. `Card` "Model settings" with `ModelSettingsForm`: Name, Description, `Switch` "Production mode" with description "Structural changes are blocked. Changes arrive through ALM sync." → "Save changes" (disabled until dirty). `Card` "Danger zone" (border-destructive) with "Delete model" → `DeleteModelDialog` → navigate to workspace. Read-only (no form controls disabled state shown as text) for planner/viewer. 404 → `EmptyState` "Model not found" with "Back to models".
- [ ] **Step 1: Write failing tests**: `create-model-dialog.test.tsx` → `requires a name`, `shows name_taken error under name`, `navigates to model on success`; `format.test.ts` → `relativeTime` cases (30 s → "just now", 2 h → "2 hours ago", 3 days → "3 days ago").
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run lint, typecheck, test, build → PASS.**
- [ ] **Step 5: Commit** `feat(web): models home, create/rename/delete and model settings`

### Task 11: Members, users admin and profile screens (Haiku)

**Files:**
- Create: `web/src/routes/_app/w/$workspaceId/members.tsx`, `web/src/routes/_app/admin/users.tsx`, `web/src/routes/_app/profile.tsx`, `web/src/features/workspaces/{members-table.tsx,add-member-dialog.tsx}`, `web/src/features/users/{api.ts,users-table.tsx,user-dialog.tsx,reset-password-dialog.tsx}`, `web/src/features/profile/{profile-form.tsx,password-form.tsx}`, `web/src/features/workspaces/add-member-dialog.test.tsx`

**Interfaces:**
- Consumes: Tasks 9–10 components and hooks; follow the patterns of Task 10 exactly (dialogs, toasts, states).
- Produces:
  - `features/users/api.ts`: `useUsers()`, `useCreateUser()`, `useUpdateUser()`, `useUpdateProfile()`, `useChangePassword()`.
  - Members page: `PageHeader` "Members" / "People who can access <workspace>." + "Add member" (workspace admin). `Table` columns Name, Email, Role, actions. Role cell: `Select` (Admin, Builder, Planner, Viewer) for workspace admins, else `Badge`. Remove: icon button → `AlertDialog` "Remove <name> from <workspace>?". 409 `workspace.last_admin` → toast error with server detail and the `Select` reverts. `AddMemberDialog`: Email + Role (`Select`, default Planner), submit "Add member"; 404 `user.not_found` and 409 `workspace.member_exists` shown under Email.
  - Users page (instance admin; others get `EmptyState` "You don't have access to this page"): `PageHeader` "Users" + "New user". `Table` Name, Email, Role (`Badge` "Instance admin" or none), Status (`Badge` "Active"/"Disabled"), actions `DropdownMenu`: Edit (`UserDialog` in edit mode: name, instance admin `Checkbox`), Reset password (`ResetPasswordDialog`), Disable/Enable (`AlertDialog` for disable). `UserDialog` create mode: Name, Email, Temporary password, Instance admin checkbox; submit "Create user".
  - Profile page: `Card` "Profile" (Name → "Save changes"); `Card` "Password" (Current, New, Confirm → "Change password"; success toast "Password changed").
- [ ] **Step 1: Write failing test** `add-member-dialog.test.tsx`: `shows user_not_found under email`; `defaults role to Planner`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run lint, typecheck, test, build → PASS.**
- [ ] **Step 5: Commit** `feat(web): members, user administration and profile screens`

### Task 12: Docker, CI and Playwright E2E (Sonnet)

**Files:**
- Create: `docker/Dockerfile`, `.dockerignore`, `compose.yml`, `.github/workflows/ci.yml`, `e2e/package.json`, `e2e/playwright.config.ts`, `e2e/scripts/start-server.sh`, `e2e/tests/{onboarding.spec.ts,models.spec.ts,members.spec.ts,shell.spec.ts}`, `e2e/tests/helpers.ts`
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the whole app.
- Produces:
  - `docker/Dockerfile` (context = repo root): stage `web` (`node:22-bookworm-slim`, `corepack enable`, `pnpm install --frozen-lockfile --filter web...`, `pnpm --dir web build`); stage `build` (`rust:1-bookworm`, copy repo + `web/dist`, `cargo build --release -p openplan-server`); stage runtime (`debian:bookworm-slim`, `ca-certificates`, non-root user `openplan`, binary at `/usr/local/bin/openplan`, `EXPOSE 8080`, `ENV OPENPLAN_BIND=0.0.0.0:8080`, `CMD ["openplan","serve"]`).
  - `compose.yml`: `postgres` (`postgres:17`, env `POSTGRES_USER/PASSWORD/DB=openplan`, volume `pgdata`, healthcheck `pg_isready -U openplan`); `openplan` (`build: {context: ., dockerfile: docker/Dockerfile}`, `ports: ["8080:8080"]`, env `DATABASE_URL=postgres://openplan:openplan@postgres:5432/openplan`, `OPENPLAN_PUBLIC_URL=http://localhost:8080`, `depends_on: postgres: condition: service_healthy`).
  - `e2e/scripts/start-server.sh`: drops and recreates DB `openplan_e2e` using `psql "$E2E_ADMIN_DATABASE_URL"` (default `postgres://postgres:postgres@localhost:5432/postgres`), then `exec ../target/debug/openplan serve` with `DATABASE_URL=.../openplan_e2e`, `OPENPLAN_BIND=127.0.0.1:8090`, `OPENPLAN_PUBLIC_URL=http://localhost:8090`.
  - `playwright.config.ts`: `@playwright/test` pinned `1.56.1`; `baseURL http://localhost:8090`; `webServer: { command: "bash scripts/start-server.sh", url: "http://localhost:8090/api/health", reuseExistingServer: false }`; `workers: 1`, `fullyParallel: false` (tests share one instance; specs run in file order with `onboarding.spec.ts` first via project dependencies: project `setup` = onboarding, project `app` depends on it); `use.trace: "retain-on-failure"`.
  - `helpers.ts`: `ADMIN = { name: "Ada Admin", email: "ada@acme.test", password: "correct-horse-battery" }`, `login(page, user)`, `screenshot(page, name)` saving `screenshots/<name>-light.png` and `-dark.png` (sets theme via `localStorage["openplan-theme"]` then reloads).
  - E2E specs:
    - `onboarding.spec.ts`: visiting `/` redirects to `/setup`; submit mismatched passwords shows "Passwords don't match."; complete setup (workspace "Acme Corp") → lands on models page with "No models yet"; screenshot `setup`, `models-empty`; sign out → `/login`; wrong password shows "Email or password is incorrect."; sign in → models page.
    - `models.spec.ts`: create "FY27 Budget" → on model page; rename to "FY27 Operating Budget" → toast; toggle Production mode → badge "Production"; back to models → card shows badge; duplicate name shows "A model with this name already exists in this workspace."; delete from card menu → empty state; screenshots `models-grid`, `model-settings`.
    - `members.spec.ts`: admin creates user "Pat Planner" (`pat@acme.test`) on Users page; adds to workspace as Planner; attempting to demote self as last admin shows toast "A workspace needs at least one admin."; sign out; sign in as Pat → sees "Acme Corp", no "New model" button, no "Users" nav item; screenshots `users`, `members`.
    - `shell.spec.ts`: `Control+K` opens palette, typing a model name and Enter navigates to it; sidebar collapses via trigger; theme Dark applies `dark` class; screenshot `command-palette`.
  - `ci.yml` jobs (on push to `main` and pull_request): `rust` (ubuntu, `services.postgres: postgres:17` with password `postgres`, `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`, `dtolnay/rust-toolchain@stable` with clippy+rustfmt, `Swatinem/rust-cache@v2`, fmt check, clippy, test); `web` (pnpm/action-setup, node 22, `pnpm install --frozen-lockfile`, lint, typecheck, test, build, then `pnpm --dir web gen:api && git diff --exit-code web/src/lib/api/schema.d.ts`) — needs rust toolchain for gen:api; `e2e` (needs `rust` and `web`; postgres service; build web, `cargo build -p openplan-server`, `pnpm --dir e2e exec playwright install --with-deps chromium`, `pnpm --dir e2e test`, upload `e2e/screenshots` and `e2e/playwright-report` as artifacts always); `docker` (`docker/build-push-action` with `push: false`).
  - `README.md`: what OpenPlan is (2 sentences), feature status list (M1 shipped; M2–M8 upcoming), Quick start (`docker compose up --build` → http://localhost:8080), Development (Postgres, `cargo run -p openplan-server`, `pnpm --dir web dev`, tests), License AGPL-3.0.
- [ ] **Step 1: Write the E2E specs above.**
- [ ] **Step 2: Run** `pnpm --dir web build && cargo build -p openplan-server && pnpm --dir e2e test` → iterate until all pass. Any failure in app code is fixed in the app (report it), never by weakening the test.
- [ ] **Step 3: Write Dockerfile, compose, CI, README.** Validate YAML (`python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/ci.yml'))"`), and if Docker is available run `docker compose build`.
- [ ] **Step 4: Run full local suite:** cargo fmt/clippy/test, web lint/typecheck/test/build, e2e → PASS. Screenshots exist in `e2e/screenshots/`.
- [ ] **Step 5: Commit** `feat: docker compose, CI pipeline and end-to-end tests`
