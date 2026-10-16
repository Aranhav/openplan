# OpenPlan — Product Design Spec

- **Date:** 2026-10-15
- **Status:** Draft for review
- **License:** AGPL-3.0
- **Repo:** https://github.com/Aranhav/openplan

## 1. Intent

OpenPlan is an open-source Enterprise Performance Management (EPM) / connected-planning platform with the modeling power and user experience of Anaplan, plus features Anaplan lacks (scenario sandboxes, built-in statistical forecasting, AI assistant).

**Who it is for:** FP&A teams, model builders and planners who want an Anaplan-class tool they can self-host; contributors who want a clean Rust + React codebase.

**Success criteria**

1. A finance user can self-host with `docker compose up`, open the browser, complete setup, load the demo model and plan a budget end to end without reading docs.
2. A model builder familiar with Anaplan recognizes every concept (lists, time, versions, modules, line items, blueprint, formulas, pages, actions, selective access, DCA, ALM) and can rebuild a typical Anaplan model.
3. Editing one input cell in a 1M-cell model shows recalculated results in under 50 ms of server time.
4. All tests (engine, server, web unit, Playwright E2E) pass in CI on every merge.

**Non-goals (initial release):** sparse storage engine (Anaplan Polaris-style; roadmap M9, §15), week/day time granularity (roadmap M10, §15), Excel add-in (roadmap M16), native mobile apps (roadmap M19), multi-node clustering (one server process owns all loaded models; roadmap M18), ERP-specific connectors (REST API + CSV/XLSX cover integration; roadmap M16).

## 2. Architecture

```
openplan/
  Cargo.toml                 workspace
  crates/engine/             pure Rust library, no I/O, no async
  crates/server/             axum binary: HTTP + WebSocket, auth, Postgres, actors, import/export, AI
  web/                       Vite + React + TS + Tailwind v4 + shadcn/ui
  docker/Dockerfile          multi-stage: web build -> rust build (web embedded) -> slim runtime
  compose.yml                services: openplan, postgres:17
  docs/                      user guide, formula reference, API guide
  e2e/                       Playwright tests (run against compose)
  .github/workflows/ci.yml
```

### 2.1 Backend stack

`axum`, `tokio`, `sqlx` (Postgres, runtime-checked `query_as` with `FromRow` so builds never need a database, migrations in `crates/server/migrations`), `serde`, `thiserror`, `tracing`, `utoipa` + `utoipa-scalar` (OpenAPI at `/api/docs`), `argon2`, `openidconnect`, `aes-gcm`, `calamine` (XLSX read), `rust_xlsxwriter` (XLSX write), `csv`, `rayon` (parallel recalc), `rust-embed` (serve built web assets), `uuid` (v7), `lettre` (SMTP), `reqwest` (AI providers).

### 2.2 Frontend stack

Vite, React 19, TypeScript (strict), Tailwind CSS v4, **shadcn/ui standard components only** (new-york style, neutral base color, CSS variables, light + dark), TanStack Router (file-based routes), TanStack Query, TanStack Virtual (grid), react-hook-form + zod (shadcn `Form`), cmdk (shadcn `Command`), Sonner (shadcn toasts), shadcn charts (Recharts), CodeMirror 6 (formula editor, themed with shadcn CSS variables), react-grid-layout (page builder), dnd-kit (pivot drag and drop), `openapi-typescript` + `openapi-fetch` (typed API client generated from the server's OpenAPI document).

Rule: any UI element that exists in shadcn/ui is built with that component. The only custom-built components are the **Grid**, the **Formula editor** and the **Page canvas**; they use shadcn design tokens (`bg-background`, `border`, `text-muted-foreground`, etc.) so they look native.

### 2.3 Runtime topology

One `openplan` process. Each model, when first accessed, is loaded from Postgres into memory and owned by a **ModelActor** (a tokio task). Idle models are checkpointed and evicted after `OPENPLAN_MODEL_IDLE_MINUTES` (default 30).

```
HTTP/WS handlers ──commands──> ModelActor (one per loaded model) ──> engine::Model (in memory)
        ^                              │
        └──── broadcast events ────────┘──> Postgres (change log, checkpoints)
```

- **Writes** (cell edits, structural edits, imports) are messages to the actor, applied strictly in order.
- **Reads** take an `Arc<ModelSnapshot>` from the actor and run on the caller's task (no actor contention).
- The engine model uses `Arc` per line-item store with copy-on-write (`Arc::make_mut`): a snapshot is a cheap clone; a write copies only the touched stores if a reader still holds the old one. Scenario sandboxes reuse the same mechanism.
- After each applied write, the actor publishes an event on a `tokio::sync::broadcast` channel consumed by WebSocket sessions.

### 2.4 Configuration (environment variables)

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection |
| `OPENPLAN_SECRET_KEY` | yes | 32-byte base64; derives cookie-signing and AES-GCM encryption keys (HKDF) |
| `OPENPLAN_PUBLIC_URL` | yes | External URL (OIDC redirects, email links) |
| `OPENPLAN_BIND` | no | Default `0.0.0.0:8080` |
| `OPENPLAN_MODEL_IDLE_MINUTES` | no | Default 30 |
| `OPENPLAN_SMTP_URL`, `OPENPLAN_SMTP_FROM` | no | Email notifications and password reset |
| `OPENPLAN_OIDC_ISSUER`, `OPENPLAN_OIDC_CLIENT_ID`, `OPENPLAN_OIDC_CLIENT_SECRET`, `OPENPLAN_OIDC_NAME` | no | SSO login button |
| `OPENPLAN_LOG` | no | tracing filter, default `info` |

AI provider settings are configured in the admin UI, not env, and stored encrypted.

## 3. Domain model

All persistent objects have a UUID v7 `id`. Names are unique per kind within a model (case-insensitive).

### 3.1 Tenancy

- **Workspace:** a container of models and members. Users may belong to several workspaces.
- **Model:** a planning application. Fields: `name`, `description`, `mode` (`dev` | `prod`), `calendar`, `created_by`, timestamps. In `prod` mode structural edits are blocked; changes arrive via ALM sync.

### 3.2 Lists

- **List:** `name`, optional `parent_list_id` (defines hierarchy levels: `Countries` with parent `Regions`), `has_top_level` + `top_level_name` (e.g. "All Regions"), `production_data` flag (items are data, excluded from ALM sync), `numbered` flag (items identified by code, display name may repeat).
- **List item:** `id`, `code` (unique per list, optional for non-numbered), `name`, `parent_item_id` (item in parent list; required when the list has a parent list), `ordinal`.
- **List subset:** named subset of a list's items; usable as a module dimension.
- **List properties** are line items in an auto-created system module named `<List> Properties`, dimensioned by that list. No separate concept.

### 3.3 Time

Model **calendar**: `fiscal_year_start_month` (1–12), `first_year` (fiscal year label), `years` (count, 1–20), `past_years_actual` (informational). Base granularity is **month**. Summary levels: quarter, half-year, fiscal year, and all-periods total.

**Time ranges:** named subranges of years; a module or line item may use a time range instead of the model calendar.

Time is a built-in dimension named `Time`. Engine index of a month = months since the calendar start.

### 3.4 Versions

Built-in dimension `Versions` with items: user-defined (defaults: `Actual`, `Budget`, `Forecast`). Each version has an optional **switchover** month: for months before it, a formula referencing that version uses `Actual` values. One version is flagged `is_actual`, one `is_current`.

### 3.5 Modules and line items

- **Module:** `name`, `dimensions` (ordered list of list/subset ids, plus optional `Time`, plus optional `Versions`), `functional_area` (folder label for navigation).
- **Line item:**
  - `name`, `module_id`, `ordinal`
  - `format`: `number{decimals, thousands_sep, unit: none|currency{code}|percent, negative: minus|parens}` | `boolean` | `text` | `date` | `list{list_id}` | `time_period{level}`
  - `formula`: optional string. If absent, the line item is **input**.
  - `summary`: `sum` | `average` | `min` | `max` | `none` | `formula` (re-evaluate the formula at summary level) | `ratio{numerator_li, denominator_li}` | `first` | `last` | `opening`/`closing` (time only: first/last period)
  - `time_summary`: optional override of `summary` along Time
  - `applies_to`: optional override of list dimensions (subset of model lists)
  - `time_scale`: `module` (default) | `none` | `month` | `quarter` | `half_year` | `year`
  - `versions`: `module` (default) | `none` | subset of versions
  - `is_summary_only`: hides leaf cells (rare)
  - `notes`, `code`
- Line item **subsets** (for charts and grids showing line items from several modules): named, list of line item ids.

### 3.6 Dimension semantics (must match Anaplan behavior)

When a formula in target line item **T** (dimensions D_T) references source line item **S** (dimensions D_S), the engine aligns each dimension:

| Case | Behavior |
|---|---|
| dim in both | same item |
| D_S has a coarser level of a D_T dim (S by `Regions`, T by `Countries`) | implicit lookup via parent mapping |
| D_S has a finer level of a D_T dim (S by `Countries`, T by `Regions`) | implicit aggregation using S's summary method |
| dim in D_T only | broadcast (same value for every item) |
| dim in D_S only, list has top level | use top-level aggregate |
| dim in D_S only, no top level | compile error: "Use SUM, LOOKUP or SELECT to map dimension X" |
| Time at different scales | coarser source → value applies to each month in the period; finer source → aggregate with time summary |
| Versions | same version; switchover applies |

## 4. Formula language

Anaplan-compatible syntax so existing model builders are productive immediately.

### 4.1 Lexical rules

- Names may contain spaces: `Gross Margin`. Consecutive word tokens are joined into one name until an operator, `(`, `)`, `[`, `]`, `,`, `:`, `.`, or keyword (`IF THEN ELSE AND OR NOT TRUE FALSE BLANK`).
- Names containing operators, punctuation or keywords are quoted with single quotes: `'Profit & Loss'`.
- Qualified reference: `Module.Line Item`, `'Module Name'.'Line Item'`.
- List item literal: `List.Item` (used in SELECT and comparisons), e.g. `Versions.Budget`, `Time.'Jan 26'`.
- Numbers: `123`, `1.5`, `1e6`. Text: `"double quotes"`, `""` escapes a quote. Booleans: `TRUE`, `FALSE`. `BLANK` = blank list item/text/date.
- Comments: `//` to end of line.
- Names and keywords are case-insensitive.

### 4.2 Grammar (precedence low → high)

```
expr      := if_expr | or_expr
if_expr   := IF expr THEN expr ELSE expr
or_expr   := and_expr (OR and_expr)*
and_expr  := not_expr (AND not_expr)*
not_expr  := NOT not_expr | cmp_expr
cmp_expr  := concat (( = | <> | < | <= | > | >= ) concat)?
concat    := add (& add)*
add       := mul (( + | - ) mul)*
mul       := unary (( * | / ) unary)*
unary     := - unary | postfix
postfix   := primary ( '[' modifier (',' modifier)* ']' )*
modifier  := (SUM | LOOKUP | SELECT | AVERAGE | MIN | MAX | ANY | ALL | FIRSTNONBLANK | LASTNONBLANK | TEXTLIST) ':' expr
primary   := number | string | TRUE | FALSE | BLANK | call | reference | '(' expr ')'
call      := NAME '(' (expr (',' expr)*)? ')'
reference := name ('.' name)?
```

### 4.3 Type system

Types: `Number`, `Boolean`, `Text`, `Date`, `ListItem(list_id)`, `TimePeriod(level)`. The compiler infers the result type of every expression and checks it equals the target line item's format (numbers coerce into percent/currency formats). Errors carry a byte span and message; unknown names include a "Did you mean" suggestion (Levenshtein ≤ 2).

### 4.4 Modifiers (cross-dimension mapping)

- `Source[SUM: Source.Map]` — `Map` is a list-formatted line item in S's dimensions pointing to items of a T dimension; values aggregate into T. Also `AVERAGE`, `MIN`, `MAX`, `ANY`, `ALL`, `FIRSTNONBLANK`, `LASTNONBLANK`, `TEXTLIST`.
- `Source[LOOKUP: Target.Map]` — `Map` is a list-formatted line item in T's dimensions pointing to items of an S dimension; gathers the value.
- `Source[SELECT: List.Item]` — fixes an S dimension to one item (also `Time.'Jan 26'`, `Versions.Actual`).

### 4.5 Functions (initial release)

| Group | Functions |
|---|---|
| Math | `ABS ROUND(x, places, [UP\|DOWN\|NEAREST]) MIN MAX POWER SQRT EXP LN LOG MOD DIVIDE SIGN` |
| Logic | `ISBLANK ISNOTBLANK ISANCESTOR(a, b) ISFIRSTOCCURRENCE(x, list)` (IF/AND/OR/NOT are syntax) |
| Text | `LEFT RIGHT MID LEN FIND UPPER LOWER TRIM SUBSTITUTE TEXT VALUE` and `&` |
| List | `ITEM(List) PARENT(item) NAME(item) CODE(item) FINDITEM(List, text)` |
| Time | `PREVIOUS(x) NEXT(x) OFFSET(x, n, default) LAG(x, n, default) LEAD(x, n, default) CUMULATE(x) MOVINGSUM(x, from, to) YEARVALUE QUARTERVALUE HALFYEARVALUE MONTHVALUE TIMESUM(x[, from, to]) YEARTODATE QUARTERTODATE HALFYEARTODATE START() END() INPERIOD(date, period) PERIOD(date) CURRENTPERIODSTART() CURRENTPERIODEND()` |
| Date | `DATE(y, m, d) DAY MONTH YEAR WEEKDAY ADDMONTHS ADDYEARS DAYS(from, to)` |
| Version | `CURRENTVERSION(x) PREVIOUSVERSION(x) NEXTVERSION(x)` |
| Rank | `RANK(x, [DESCENDING\|ASCENDING])` |
| Finance | `NPV(rate, x) IRR(x) PMT(rate, nper, pv) PV(rate, nper, pmt) FV(rate, nper, pmt, pv)` |

### 4.6 Evaluation semantics (Anaplan-compatible)

- Division by zero → `0`. `DIVIDE(a, b)` identical.
- Blank number = `0`; blank boolean = `FALSE`; blank text = `""`.
- `PREVIOUS`/`OFFSET` beyond the timeline → `0` (or the given default).
- Numbers are `f64`. Display rounding is a format concern, never applied in calculation.

## 5. Engine (`crates/engine`)

Pure, synchronous, deterministic. No I/O. Public API is the contract for the server.

### 5.1 Storage

- Each line item owns a **dense** `CellStore` over its effective dimensions (applies-to + time scale + versions), leaf level only. Typed column vectors: `Vec<f64>` (number), bit vector (boolean), `Vec<u32>` (text via per-model string interner, list item index, time period), `Vec<i32>` (date, days since 1970-01-01).
- Coordinates map to a linear index via row-major strides. Dimension order: lists (module order), then Time, then Versions.
- List items get dense `u32` indices in memory; persisted by UUID. Deleted items are tombstoned and compacted when the model is next loaded.
- Summary values (hierarchy parents, top levels, quarters, years) are **not stored**; they are computed on read through the summary method and cached per (line item, summary level, generation). Cache entries invalidate when the line item's generation counter changes.

### 5.2 Compilation

`formula text → tokens → AST → typed IR → ExecPlan`. The ExecPlan evaluates a whole line item at once: each source reference becomes an aligned reader (strides + per-dimension index maps from §3.6) that produces the source value for any target linear index. Evaluation iterates target cells in parallel chunks (`rayon`).

### 5.3 Dependency graph and recalculation

- Nodes: line items. Edges: formula references (including mapping line items and list-property references).
- On formula save: rebuild affected edges and check for cycles. A cycle is **allowed** only if at least one edge in the cycle is a backward time shift with a constant offset on Time: `PREVIOUS(x)`, `LAG(x, n, d)` with constant n ≥ 1, or `OFFSET(x, n, d)` with constant n ≤ -1. Such a strongly connected component is evaluated **period by period** in time order. Any other cycle is a compile error naming the line items involved.
- On input change: the changed line items' dependents (transitive) are marked dirty and recalculated in topological order. Independent line items in the same topological layer run in parallel.
- **Pointwise fast path:** if a dirty line item's formula is pointwise relative to the changed cells (no modifiers, time shifts, aggregations or RANK on the changed path), only the affected cell indices are recomputed.
- Each recalc returns a `ChangeSet { generation, changed_line_items, changed_cells_count }`.

### 5.4 Engine public API (Rust, indicative)

```rust
pub struct Model { /* lists, calendar, versions, modules, line items, stores, graph */ }
impl Model {
    pub fn new(calendar: Calendar) -> Self;
    pub fn apply(&mut self, cmd: Command) -> Result<ChangeSet, EngineError>; // structural + data commands
    pub fn snapshot(&self) -> Arc<ModelSnapshot>;
}
pub enum Command {
    CreateList{..}, UpdateList{..}, DeleteList{..}, UpsertListItems{..}, DeleteListItems{..},
    CreateModule{..}, UpdateModule{..}, DeleteModule{..},
    CreateLineItem{..}, UpdateLineItem{..}, DeleteLineItem{..},
    SetCalendar{..}, UpsertVersion{..}, DeleteVersion{..},
    SetCells{ edits: Vec<CellEdit> },
}
impl ModelSnapshot {
    pub fn query(&self, q: &ViewQuery) -> Result<ViewResult, EngineError>;   // grid window incl. summaries
    pub fn cell(&self, li: LineItemId, coords: &[ItemRef]) -> Value;
    pub fn compile_check(&self, li: LineItemId, formula: &str) -> Result<TypeInfo, Vec<FormulaError>>;
    pub fn trace(&self, li: LineItemId, coords: &[ItemRef]) -> Trace;        // drill to source, AI variance
}
```

Exact signatures are fixed in the M2 implementation plan.

### 5.5 Forecasting (`engine::forecast`)

Pure functions over `&[f64]` time series: linear trend (least squares), moving average (window n), Holt-Winters additive (seasonality 12, parameters fitted by grid search minimizing SSE). `auto` back-tests each method on the last `min(12, len/4)` points and picks the lowest MAPE. Returns `{method, values, mape}`.

## 6. Persistence (Postgres)

Migrations live in `crates/server/migrations`. Tables (key columns only):

| Table | Purpose |
|---|---|
| `users(id, email unique, name, password_hash null, is_instance_admin, disabled, created_at)` | accounts |
| `user_identities(user_id, issuer, subject)` | OIDC links |
| `sessions(id_hash, user_id, expires_at, created_at, user_agent)` | browser sessions |
| `api_tokens(id, user_id, name, token_hash, last_used_at, expires_at)` | personal access tokens |
| `workspaces(id, name, created_at)` / `workspace_members(workspace_id, user_id, role)` | tenancy; role ∈ `admin`, `builder`, `planner`, `viewer` |
| `models(id, workspace_id, name, description, mode, calendar jsonb, checkpoint_seq, created_by, timestamps)` | model header |
| `model_structure(model_id, doc jsonb, updated_at)` | the model's structure as one document the engine reads and writes (`StructureDoc`): lists with their items, modules, line items, versions, subsets and time ranges, and later views, pages, actions, processes, workflows and roles. Replaced as a whole at each checkpoint; what changed in between is in `change_log` |
| `line_item_data(model_id, line_item_id, chunk, data bytea)` | checkpointed input cells (binary, zstd) |
| `change_log(model_id, seq bigserial, user_id, at, kind, payload jsonb, line_item_id null, cell_key null)` | every write; audit, history, undo, replay |
| `comments(id, model_id, line_item_id, cell_key, thread_id, author_id, body, resolved, created_at)` | cell comments |
| `notifications(id, user_id, kind, payload jsonb, read_at, created_at)` | in-app notifications |
| `revisions(id, model_id, name, description, structure bytea, created_by, created_at)` | ALM tags |
| `model_links(source_model_id, target_model_id, last_synced_revision_id)` | ALM sync pairs |
| `scenarios(id, model_id, owner_id, name, base_seq, status, created_at)` + overlay edits in `change_log` with `scenario_id` | sandboxes |
| `workflow_instances(id, model_id, workflow_id, item_id, step_index, status, assignee_id, updated_at)` | workflow state |
| `ai_settings(workspace_id, provider, base_url, model, api_key_encrypted, enabled)` | AI config |
| `import_runs(id, model_id, action_id, user_id, status, report jsonb, created_at)` | import history |

**Load:** read `model_structure` → read latest `line_item_data` checkpoint → replay `change_log` rows with `seq > checkpoint_seq` → full recalc.
**Checkpoint:** every 10,000 change-log rows or on eviction, write all dirty input stores and advance `checkpoint_seq`, in one transaction.
**Cell key:** canonical string `"<item uuid>|<item uuid>|...|<period index>|<version uuid>"` for comments, history and selective lookups.

## 7. API

REST under `/api/v1`, JSON, OpenAPI documented. Errors use RFC 7807 `application/problem+json` with stable `code` (e.g. `formula.unknown_name`, `auth.forbidden`, `cells.locked`).

| Area | Endpoints (indicative) |
|---|---|
| Setup/auth | `GET /setup/status`, `POST /setup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/oidc/start`, `GET /auth/oidc/callback`, `POST /auth/password-reset` |
| Users/tokens | CRUD `/users`, `/me/tokens` |
| Workspaces | CRUD `/workspaces`, `/workspaces/{id}/members` |
| Models | CRUD `/workspaces/{id}/models`, `POST /models/{id}/copy`, `GET /models/{id}/export` (.openplan), `POST /workspaces/{id}/models/import` |
| Structure | CRUD `/models/{id}/lists`, `/lists/{id}/items` (bulk), `/models/{id}/modules`, `/modules/{id}/line-items`, `/models/{id}/versions`, `/models/{id}/calendar`, `/models/{id}/subsets` |
| Formulas | `POST /models/{id}/formula/check` → type info or errors with spans; `GET /models/{id}/formula/completions?prefix=` |
| Data | `POST /models/{id}/query` (ViewQuery → ViewResult window), `POST /models/{id}/cells` (batch edits), `GET /models/{id}/cells/history?line_item&cell_key`, `GET /models/{id}/trace` |
| Views/pages | CRUD `/modules/{id}/views`, `/models/{id}/pages` |
| Data I/O | CRUD `/models/{id}/actions`, `POST /actions/{id}/run` (multipart for imports), CRUD `/models/{id}/processes`, `POST /processes/{id}/run`, `POST /models/{id}/export` (view → CSV/XLSX) |
| Security | CRUD `/models/{id}/roles`, `/models/{id}/access` (selective access grants), `/models/{id}/period-locks` |
| Workflow | CRUD `/models/{id}/workflows`, `POST /workflow-instances/{id}/{submit\|approve\|reject}` |
| Collaboration | CRUD `/models/{id}/comments`, `GET /models/{id}/audit`, `POST /models/{id}/undo`, `GET/PATCH /notifications` |
| ALM | CRUD `/models/{id}/revisions`, `GET /revisions/{a}/diff/{b}`, `POST /models/{id}/sync` |
| Scenarios | CRUD `/models/{id}/scenarios`, `GET /scenarios/{id}/compare`, `POST /scenarios/{id}/merge` |
| AI | `GET/PUT /workspaces/{id}/ai-settings`, `POST /models/{id}/ai/formula`, `POST /models/{id}/ai/explain-formula`, `POST /models/{id}/ai/explain-variance`, `POST /models/{id}/ai/scaffold` |

**ViewQuery:** `{ module_id, line_item_ids?, rows: [dim], columns: [dim], pages: {dim: item}, filters, show_summaries, window: {row_offset, row_limit, col_offset, col_limit}, scenario_id? }`.
**ViewResult:** row headers (with depth, is_summary, item ids), column headers, `cells[r][c] = {v, fmt, flags}` where flags ∈ `input`, `calculated`, `summary`, `readonly`, `locked`, `commented`, plus total row/column counts.

**WebSocket** `GET /api/v1/models/{id}/live` (cookie or token auth). Server → client: `cells_changed{seq, line_item_ids, user_id}`, `structure_changed{seq, kinds}`, `presence{users:[{id, name, module_id, cell}]}`, `comment_added`, `notification`. Client → server: `presence_update{module_id, cell}`. On `cells_changed` the client refetches only the visible window if any visible line item changed. Every message carries `seq`; a gap triggers a full refetch.

**Typed client:** `web/src/lib/api/schema.d.ts` is generated from `/api/openapi.json` by `pnpm gen:api`.

## 8. Security

### 8.1 Authentication

- First run: `/setup` creates the instance admin and first workspace; disabled afterwards.
- Password login (argon2id), rate-limited (10 attempts / 15 min per email+IP).
- OIDC login when configured; first OIDC login auto-creates the user only if an admin invited that email.
- Session cookie `op_session`: random 256-bit token, stored hashed, `HttpOnly`, `Secure` (when public URL is https), `SameSite=Lax`, 14-day sliding expiry.
- CSRF: mutating requests with cookie auth must carry header `X-OpenPlan-CSRF` matching the `op_csrf` cookie.
- API tokens: `op_pat_<random>`, shown once, stored hashed, `Authorization: Bearer`.

### 8.2 Authorization (evaluated server-side for every query and write)

1. **Workspace role:** `admin` (everything), `builder` (edit structure of models, full data access), `planner` (data access per model role), `viewer` (read-only per model role).
2. **Model roles** (custom, per model): per module `none|read|write`, per line item override. Planners/viewers are assigned one model role.
3. **Selective access:** per list (flagged `selective_access`), per user/role: set of items with `read` or `write`. Children inherit from parents unless overridden.
4. **Dynamic cell access (DCA):** a line item may name a boolean `read_access_driver` and/or `write_access_driver` line item; cell is readable/writable only where the driver is TRUE.
5. **Period locks:** per version, months up to a date are read-only for non-admins.
6. **Workflow locks:** a submitted workflow instance makes its item's slice read-only for the assignee until approved/rejected.

Effective rule: the most restrictive wins. Query results omit unreadable rows/columns entirely and mark non-writable cells `readonly`/`locked`. Writes to any non-writable cell reject the whole batch with `cells.locked` listing the offending cells. Builders/admins bypass 2–4 but not 5–6 unless they explicitly unlock.

### 8.3 Secrets

AI API keys encrypted with AES-256-GCM (key derived from `OPENPLAN_SECRET_KEY` via HKDF, info `ai-keys`). Keys never returned by the API (only `has_key: true`).

## 9. UX specification

The UX mirrors Anaplan's concepts and flow, implemented with standard shadcn/ui components.

### 9.1 Shell

- shadcn `Sidebar` (collapsible to icons) + `SidebarInset`.
- Top bar: `SidebarTrigger`, `Breadcrumb` (Workspace › Model › Module/Page), mode switch `Tabs` (**Build** / **Use**), `⌘K` command palette (`CommandDialog`) searching modules, lists, line items, pages, actions; notifications bell (`Popover` + list); avatar `DropdownMenu` (profile, tokens, theme light/dark/system, sign out).
- Home (`/`): workspace switcher (`Select`), model cards (`Card`) with mode badge (`Badge` dev/prod), "New model" (`Dialog`), "Import .openplan", "Load demo model".

### 9.2 Build mode sidebar (per model)

Groups: **Structure** (Lists, Time, Versions, Modules grouped by functional area), **Data** (Actions, Processes, Import history), **Apps** (Pages, Workflows), **Admin** (Users & Roles, Selective access, Period locks, Revisions & Sync, Settings).

### 9.3 Module screen (Build)

- Header: module name (inline rename), dimensions as `Badge`s, `Tabs`: **Grid** | **Blueprint**.
- **Grid tab toolbar:** Pivot (`Popover` with three dnd-kit drop zones: Rows, Columns, Pages); page selectors (`Select`, or searchable `Popover`+`Command` for lists > 20 items) for each page dimension; Filter (`Popover`); Show/Hide items (`Popover` with `Checkbox` tree); Conditional formatting (`Sheet`); Saved views (`Select` + Save/Save as); Export (`DropdownMenu`: CSV, XLSX); Add comment.
- **Blueprint tab:** shadcn `Table` of line items: Name, Format, Formula (truncated, monospace), Applies To, Time Scale, Versions, Summary, Notes. Drag handle reorders. Row click selects; the **formula bar** above shows the selected line item's formula in the Formula editor with live validation. A right `Sheet` "Line item settings" edits all properties via shadcn `Form`. "Add line item" button inserts below selection.

### 9.4 Grid component (custom)

- Virtualized rows and columns (TanStack Virtual), sticky column headers and row headers, multi-level headers for nested dimensions.
- Hierarchy rows: expand/collapse chevrons; summary rows/columns bold with `bg-muted/40`.
- Cell styling: input cells `bg-background`; calculated cells `bg-muted/30` (values always `text-foreground` for readability); readonly/locked show a lock icon on hover and `cursor-not-allowed`; negative numbers per format; commented cells show a corner triangle.
- Editing: type to replace, `Enter`/`F2`/double-click to edit, `Esc` cancels, `Enter` commits and moves down, `Tab` moves right. Booleans toggle with `Space` (checkbox). List-formatted cells open a `Command` dropdown. Dates open shadcn `Calendar` in a `Popover`.
- Selection: click, shift-click, drag, `Ctrl/⌘+A`; arrow keys; `Shift+arrows` extend.
- Clipboard: copy as TSV; paste TSV (from Excel/Sheets) into a range with validation; `Ctrl+D` fill down.
- Undo/redo: `⌘Z` / `⌘⇧Z` for the user's own edits.
- Context menu (`ContextMenu`): Comment, Cell history (`Sheet` with timeline), Drill to source (`Sheet` with trace tree), Copy, Paste, Fill down.
- Optimistic edits: value shows immediately with a subtle pending style; on rejection it reverts and a Sonner toast explains why.
- Presence: other users' selected cell outlined in their avatar color; avatars (`Avatar` stack) in toolbar.
- Accessibility: `role="grid"`, `aria-rowindex`/`aria-colindex`, focus visible ring, full keyboard operation.

### 9.5 Lists screen

Tree-table (shadcn `Table` with indent + chevrons, virtualized for > 500 items) with columns Name, Code, Parent, and one column per property line item (editable inline via the Grid component in single-column mode). Toolbar: Add item, Bulk add (`Dialog` with textarea, one per line), Import, Delete (`AlertDialog`), Subsets (`Sheet`), List settings (`Sheet`).

### 9.6 Time and Versions screens

Time: `Form` for fiscal year start, first year, years; preview `Table` of periods; Time ranges `Table`. Versions: `Table` with name, is actual, is current, switchover (`Select` of months), add/remove.

### 9.7 Pages (dashboards)

- **Use mode:** page renders cards in a 12-column grid; page-level context selectors in a sticky header drive every card bound to those dimensions.
- **Edit mode:** toggle in page header; card palette (`Sheet`) with types **Grid**, **Chart** (bar, line, area, pie, combo, waterfall), **KPI** (value + delta vs comparison selection + sparkline), **Text** (markdown), **Action button** (run action/process with confirm `AlertDialog`), **Image**. Cards drag/resize (react-grid-layout). Card config in a right `Sheet` with `Form`.
- Charts use shadcn `ChartContainer` + Recharts with `--chart-1..5` colors.

### 9.8 Import wizard

`Dialog` with stepper: 1) upload CSV/XLSX (drag-and-drop zone, sheet picker for XLSX), 2) choose target (list or module), 3) map columns (`Select` per column; auto-match by name), 4) preview first 100 rows in `Table` with problem cells highlighted, 5) run; result summary with counts and "Download error report". "Save as action" stores the mapping.

### 9.9 Workflow

Builder: `Form` for name, driving list, steps (task/approval, page, assignee rule). Status board: `Table` per list item with step, status `Badge`, assignee, actions (Submit/Approve/Reject with comment `Dialog`). Assignee's "My tasks" appear in Use mode sidebar.

### 9.10 Admin

Users & Roles: `Table`s with invite (`Dialog`), workspace role `Select`, model role editor (matrix `Table` of modules × none/read/write via `RadioGroup`). Selective access: per list, user × item matrix with search. Period locks: per version `Select` "locked through". Revisions: `Table` + "Add revision tag" `Dialog`, compare (diff `Table` grouped by kind), Sync (`Dialog` choosing target model, preview diff, confirm). Settings: AI provider `Form` (provider `Select`: Anthropic / OpenAI-compatible; base URL; model; API key `Input type=password`; "Test connection" button).

### 9.11 Scenario sandboxes

From model header `DropdownMenu`: "New scenario". When active, a top banner (`Alert`) shows scenario name with Compare, Merge, Discard. All screens operate on the scenario. Compare opens a `Sheet` listing changed inputs and top changed outputs (base vs scenario, delta, %). Merge shows conflicts (base changed since scenario creation) with per-cell choose base/scenario.

### 9.12 AI assistant

Right `Sheet` toggled from toolbar (sparkle icon), disabled with explanation when AI is not configured. Modes: **Write formula** (prompt → formula + explanation, "Insert" puts it in the formula bar; only shown after the server compiler validates it), **Explain formula**, **Explain variance** (for the selected cell: compares two versions/periods, follows trace, returns narrative + top drivers table), **Build model** (description → proposed lists/modules/line items shown as a diff tree with checkboxes → Apply). Footer note: "Sends model structure and selected values to <provider>."

### 9.13 States and feedback

Every data view has: loading skeleton (`Skeleton`), empty state (icon, one-sentence explanation, primary action `Button`), error state (`Alert variant=destructive` with retry). Destructive actions use `AlertDialog`. Success/error feedback via Sonner. All forms validate with zod and show field errors inline.

## 10. AI integration

- Provider trait `LlmProvider { async fn complete(&self, req: LlmRequest) -> Result<LlmResponse> }` with implementations `Anthropic` (Messages API) and `OpenAiCompatible` (Chat Completions; covers OpenAI, Ollama, vLLM, OpenRouter, LM Studio).
- **Formula assistant:** prompt = function reference (generated from the engine's function table) + model outline (modules, line items with formats and dimensions, lists) + target line item. Response parsed for a formula; server runs `compile_check`; on error, one repair round with the compiler message; if still invalid, return the error instead of a formula.
- **Explain variance:** server builds the trace (§5.4) for the cell in both contexts, sends top contributing drivers and values; response is narrative text.
- **Build model:** LLM returns JSON matching a schema of lists/modules/line items; server validates (names, formats, formulas compile in dependency order) and returns a structural diff preview; apply executes the commands as one change set.
- Timeouts 60 s, no retries on 4xx, one retry on 5xx/timeouts. Token usage logged at `debug`.

## 11. ALM and model files

- **Revision tag:** snapshot of structure (the `model_structure` document, without the items of `production_data` lists), zstd-compressed JSON.
- **Diff:** by object id: added / removed / changed (field-level).
- **Sync:** target must be linked to the source (created via "Copy model" or "Import .openplan" that preserves ids). Applies the structural diff between the target's last synced revision and the chosen revision; data in target is preserved; line items removed lose their data (confirmed in UI).
- **`.openplan` file:** zip containing `manifest.json` (format version, app version), `structure.json`, `data/*.bin` (input cells, optional), `pages.json`.

## 12. Error handling

- Server: `AppError` enum (thiserror) → problem+json with `status`, `code`, `title`, `detail`, optional `errors[]` (field or cell list). Internal errors log with a request id (also returned in `X-Request-Id`) and never leak internals.
- Engine: `EngineError` variants for compile (with spans), type, cycle (with path), not found, dimension mismatch, invalid value.
- Imports never fail silently: each rejected row is recorded with reason.
- Web: TanStack Query retries GETs twice (not 4xx); mutations surface errors via Sonner; 401 redirects to login preserving return path; WebSocket auto-reconnects with backoff (1 s → 30 s) and resyncs.

## 13. Testing strategy

| Layer | Tooling | Must cover |
|---|---|---|
| Engine | `cargo test`, `proptest`, `criterion` | parser (every grammar rule), type checker (every error), every function, dimension alignment table §3.6, cycles incl. PREVIOUS cycles, summaries, property test: incremental recalc ≡ full recalc, forecast methods |
| Server | `cargo test` with real Postgres (`sqlx::test`) | every endpoint happy + error path, auth/CSRF, **authorization leak tests** (selective access, DCA, period/workflow locks never expose or allow writes), load/replay/checkpoint round trip, import/export round trip |
| Web unit | Vitest + Testing Library | grid keyboard/selection/clipboard logic, formula editor tokenizer, forms validation |
| E2E | Playwright against `docker compose` | setup → create model → lists → time → module → formulas → input → totals → page with chart → import CSV → workflow submit/approve → comment → revision/sync → scenario compare/merge; screenshots light + dark |
| Perf | criterion bench | 1M-cell edit-to-recalc < 50 ms; 10M-cell load < 5 s |

CI (`.github/workflows/ci.yml`): `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, Playwright, `docker build`.

## 14. Demo model

"Acme Corp FP&A", created by a seed routine in the server (not a static dump): lists Regions › Countries, Products › Product Families, Cost Centers, Employees; 3 fiscal years; versions Actual/Budget/Forecast; modules Revenue Plan, Opex Plan, Headcount Plan, P&L, KPIs; 24 months of seeded actuals; pages "Executive Overview" and "Department Budget"; workflow "Budget Submission" by Cost Center.

## 15. Milestones

Each milestone gets its own implementation plan in `docs/superpowers/plans/`, is built by subagents (Sonnet for complex tasks, Haiku for mechanical tasks), reviewed against this spec, verified (tests + screenshots), merged to `main` via PR.

| # | Name | Deliverables |
|---|---|---|
| M1 | Foundation | Workspace layout, CI, Docker/compose, migrations base, auth (setup, password, sessions, CSRF), users/workspaces/models CRUD, app shell (sidebar, breadcrumbs, command palette skeleton, theme), home screen |
| M2 | Engine | Lists, calendar, versions, modules, line items, formula lexer/parser/typechecker/compiler, all §4.5 functions, dimension alignment, dependency graph, recalc + fast path, summaries, persistence load/replay/checkpoint, ModelActor, structure + data APIs |
| M3 | Grid & Blueprint | Grid component, ViewQuery, pivot, page selectors, filters, saved views, conditional formatting, editing/clipboard/undo, formula editor + formula bar, blueprint, line item settings, lists/time/versions screens, live updates |
| M4 | Pages & Data | Page builder and cards, charts, KPI, context selectors, import wizard, actions, processes, export CSV/XLSX, API tokens, OpenAPI docs |
| M5 | Security & Workflow | Model roles, selective access, DCA, period locks, workflow builder + instances + locks, notifications (in-app + email), OIDC |
| M6 | Collaboration & ALM | Comments + mentions, presence, audit log, cell history, drill to source, revisions, diff, sync, `.openplan` export/import, model copy |
| M7 | Advanced | Scenario sandboxes, forecasting action, AI provider settings + four AI features |
| M8 | Launch | Demo model, docs (user guide, formula reference, API guide), perf benchmarks, accessibility audit, README with screenshots, release Docker image workflow |

### Roadmap after the initial release

Built only after M8 merges, in this order. Each gets its own design spec and plan before any code.

| # | Name | Deliverables |
|---|---|---|
| M9 | Sparse engine | Hybrid storage chosen per line item from its fill: dense columns as today for well-filled data, block-sparse storage for sparse data. Block-sparse means sparse across the outer dimensions (only combinations that hold data get a block) and dense inside a block (time and versions as plain arrays, so the vectorised kernels keep dense speed). Sorted mixed-radix keys with a default value per line item (only exceptions stored); sparsity-aware operators (product → intersection, sum → union, IF follows its condition); formulas that would fill a huge space keep a default instead of materialising; summaries as streaming group-by over sorted keys, parallel over blocks; change-set (key-level) incremental recalc; codec and checkpoints for blocks; view queries and alignment over sparse keys. The per-line-item cell cap moves from allocated to populated cells. Every engine test runs on both storages with property tests proving identical results. Targets: 100M populated cells in a 54-billion-cell space within about 3 GB; a one-cell edit recalculates in under 50 ms; well-filled data within 1.2× of today's dense speed. |
| M10 | Week and day time | Week and day time levels; ISO weeks and 4-4-5 / 4-5-4 / 5-4-4 retail calendars and 13-period years; week↔month mapping for weeks that span months; time functions, summaries, switchover and time ranges at week and day level; Time screen and grid support. Depends on M9 because day-level models are large and sparse. |
| M11 | Forecasting and ML engine | An internal forecasting engine that runs inside OpenPlan. Data never leaves the server, and it is separate from the M7 AI features, which explain and assist. **Demand classification** (Syntetos–Boylan ADI/CV²: smooth, erratic, intermittent, lumpy) routes each series to suitable methods. **Statistical:** full ETS family (additive/multiplicative error, trend and seasonality, damped trend) with AICc selection; AutoARIMA; Theta and Optimized Theta; MSTL for multiple seasonalities (weekly + yearly). **Intermittent demand:** Croston, SBA and TSB (for obsolescence), ADIDA. **Machine learning:** global gradient-boosted tree models trained across all series, with lag, rolling, calendar, holiday, price and promotion features (the approach that won the M5 competition); external drivers as regressors. **Optional pre-trained time-series foundation model** run locally on CPU through ONNX for zero-shot forecasts. **Ensembles** of the best methods per series. **Hierarchical reconciliation** (bottom-up, top-down, MinT) so SKU, family and region forecasts add up. **Probabilistic forecasts** (P10/P50/P90) for safety stock. **Rolling-origin back-testing** with MAPE, WAPE, MASE, RMSSE and bias, and automatic per-series model choice. **Explainability:** trend/seasonality/driver decomposition and feature importance. Runs as background jobs, parallel over series, writing results as one batch through the model actor, and can be scheduled to retrain. Weekly seasonality depends on M10; large SKU × location sets benefit from M9. |
| M12 | Planning methods | **Breakback**: type a value on a summary cell and spread it to its children, in proportion, evenly or by a driver, with locked cells kept. **SPREAD and allocation functions.** **Allocation engine**: multi-step cost allocations (direct, step-down, reciprocal, activity-based) as declared rules with an audit of every step. **Multi-currency**: rate tables by version and period, conversion functions, reporting currency, translation (average and closing rate). **BOM explosion**: multi-level recursive bills of materials. **Goal seek.** |
| M13 | Financial consolidation and close | Legal entities and ownership; intercompany matching and eliminations; currency translation with CTA; minority interest; journals (manual and recurring) with approval; account mapping from the GL; close calendar and task checklist; balance sheet and cash flow checks; audit trail for every number. |
| M14 | Optimizer | Linear and mixed-integer solver for supply and production planning, inventory deployment, workforce scheduling, and territory and quota balancing. Objective, constraints and decisions are mapped to line items; results are written back as one batch; infeasibility is explained. |
| M15 | Sales performance and incentive compensation | Territory design with map views; quota setting with breakback (M12); capacity planning; a transaction-level crediting engine (rules, splits, hierarchies, effective dating) on large transaction lists (M9); commission plans (tiers, accelerators, caps, draws, clawbacks); a payee statements portal for external users; disputes workflow; payroll export. |
| M16 | Integration hub | Native connectors: Salesforce, HubSpot, NetSuite, SAP, Oracle, Microsoft Dynamics, QuickBooks, Xero, Workday, BambooHR, Snowflake, BigQuery, Redshift, Postgres, MySQL, S3, Google Sheets. Scheduled imports, actions and processes; incremental loads; webhooks and an events API; an Excel add-in and a Google Sheets add-on with live read and write. |
| M17 | Reporting and distribution | Paginated, pixel-accurate financial reports and board books; PDF, PowerPoint and formatted Excel output; scheduled email distribution with access applied per recipient; variance commentary woven into reports; map charts. |
| M18 | Enterprise scale and security | Multi-node clustering with model placement and failover; high availability and backups; SAML SSO and SCIM provisioning; customer-managed encryption keys; data residency; audit export to SIEM; internationalisation (translations, locale number/date formats, right-to-left); SOC 2 readiness. |
| M19 | Use-case applications and mobile | Ready-to-use application templates, each a model plus pages, imports and workflow, installable from a gallery, for every use case in the table below; installable mobile app (approvals, dashboards, comments, notifications). |

#### Use-case coverage

| Area | Use cases | Covered by |
|---|---|---|
| Finance | Budgeting, rolling forecasts, long-range plans, driver-based plans, 3-statement models | M1–M8 |
| Finance | Capex and depreciation, lease schedules, project budgets | M1–M8 + M19 templates |
| Finance | Cost allocation and profitability, multi-currency planning | M12 |
| Finance | Consolidation, intercompany, close management | M13 |
| Finance | Daily cash flow and treasury | M10 + M19 |
| Finance | Board reporting and management packs | M4 + M17 |
| Sales | Territory and quota planning, sales capacity | M12 + M15 |
| Sales | Incentive compensation and commissions | M15 |
| Sales | Pipeline and bookings forecasting from CRM | M11 + M16 |
| Supply chain | Demand planning and forecasting | M11 |
| Supply chain | S&OP / IBP consensus | M5 + M11 |
| Supply chain | Supply, inventory, production and distribution planning | M12 (BOM) + M14 |
| Supply chain | Retail merchandise planning and open-to-buy, assortment | M9 + M10 + M19 |
| Workforce | Headcount, compensation, hiring and attrition plans | M1–M8 + M16 (HRIS) + M19 |
| Workforce | Workforce scheduling | M10 + M14 |
| Marketing | Budget and campaign planning, ROI | M1–M8 + M19 |
| Marketing | Marketing mix modelling | M11 |
| Operations | IT and cloud spend (FinOps), procurement and spend planning | M16 + M19 |
| Industry | Banking (loan books, interest-rate risk), insurance, healthcare, public sector (position budgeting, grants), ESG and emissions planning | M12 + M19 templates |
