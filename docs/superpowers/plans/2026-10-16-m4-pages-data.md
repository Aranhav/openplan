# M4 Pages & Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task section below, together with the Global Constraints, the Constants table and the Endpoint-table rows it names, is a complete brief: it never depends on the text of another task, only on the *Produces* of the tasks it lists under *Depends on*.

**Goal:** Planners consume models through dashboard pages (grid, chart, KPI, text, image and action cards driven by page-level context selectors), and data moves in and out: a CSV/XLSX import wizard backed by saved import actions and processes, view export to CSV/XLSX, personal API tokens for scripted access, and a Developer page that documents the API.

**Architecture:** Pages are JSON definitions stored per model in a table (as saved views are); every data card is a saved or inline view (M3 `ViewDefinition`) whose page selections are overridden by the page's context selectors, so cards reuse `POST /models/{id}/query`. **Actions and processes are part of the model's structure document** (spec §6: the document holds "actions, processes"), so engine integrity, the change log, checkpoints, ALM and model copy carry them; only what §6 lists as tables stays a table (`api_tokens`, `import_runs`) plus `import_uploads` and `pages`. Imports are a two-phase server flow: upload (stored, owner-checked, 24 h) then preview (typed parse, auto-match, validate the first 100 rows) then run. **A run is owned by a detached server task, not by the request** that started it: its history row (`running`) is written before the first chunk and updated after each; the request waits up to 10 s and answers `200` with the report if the run is done, else `202` with the run id, and the client follows the run through `GET /import-runs/{run_id}`. A run is applied in **chunks of at most 100,000 cells, each chunk its own engine batch through the model actor; it is not atomic across chunks** (a chunk never splits a row). Imports do not use the query `Work` permits: they have their own gate (one run per instance at a time; two parsing/previewing reads). A saved mapping is an **action** (mapped by column **header name**; index only for files without a header row); a **process** runs actions in order, each from an already uploaded file. Export pages through the engine in 1,000 x 200 windows and streams CSV; XLSX is written in constant-memory mode. API tokens authenticate with `Authorization: Bearer op_pat_…`, carry a scope (`read` or `read_write`), act as their owner, and can never reach token, password, user, workspace or member management (`403 auth.session_required`). Build/Use mode is **derived from the URL** (Use = the pages routes); the last mode used per model only chooses the landing page.

**Tech Stack:** Server: `csv 1`, `calamine 0.36` (feature `chrono`), `rust_xlsxwriter 0.99` (feature `chrono`), `encoding_rs 0.8`, `zip` (the major version `calamine 0.36` depends on; check `cargo tree -i zip`), axum feature `multipart` (workspace `axum = { features = ["ws", "multipart"] }`, added by S0). Engine: no new crates. Web: shadcn `chart` (adds `recharts`), `progress`, plus `toggle-group` and `scroll-area` from M3 G4; `react-grid-layout ^2.3.0` (the 2.x line; 1.5.x is the `legacy` tag), `react-markdown ^10`, `rehype-sanitize ^6`. E2E: `exceljs ^4.4.0` (dev). Newest compatible patch versions apply (CLAUDE.md). "MB" in any copy or comment means MiB (1,048,576 bytes).

**Spec:** `docs/superpowers/specs/2026-10-15-openplan-design.md` §6 (`api_tokens`, `import_runs`, structure document), §7 (data I/O, views/pages, tokens), §8.1 (API tokens), §9.1 (Build/Use), §9.2 (Data and Apps groups), §9.3 (Export, Import entry points), §9.5 (Lists "Import"), §9.7, §9.8, §9.13, §12 (imports never fail silently), §15 (M4 incl. "OpenAPI docs"). §1/§2.1/§3/§6/§7/§8.1/§9.1/§9.2/§9.5/§9.7/§9.8/§11/§12/§15 need the amendments in **Spec changes** (end of this document).

**Precondition:** M3 including task G4 (grid toolbar, `view-state.ts`, saved views UI, `?view=`) and M3 X1 is merged to `main`. This plan is written against G4's interfaces as found in its working tree (`web/src/features/grid/toolbar/*`, `view-state.ts` with `reduceView`, `queryOf`, `dimKey`, `useSavedViews`, shadcn `toggle-group` and `scroll-area`). Re-read the merged files before using them; names that G4 may have spelled differently are marked "(G4 name)".

## Decisions taken (rulings of 2026-10-16, binding)

1. **Large imports (C1):** chunks of at most 100,000 cells (the M3 write cap), one engine batch per chunk, not atomic across chunks. A failure mid-run gives status `partial` with chunks applied, rows applied, rows rejected. Upload and file-cell caps are constants **to be measured** by a release-mode allocation test; start at 50 MiB and 5,000,000 cells (rows x columns of the sheet). The budget is derived, not guessed: a 512 MB instance keeps about 150 MB for the server and the loaded models and a margin of at least 50 MB (the working sets of up to four query `Work` permits, an upload body still being received, allocator slack), so one run (peak R) plus two reads (peak P each) must satisfy `R + 2P <= 310 MB`; tasks D1a1/D1a2, D1b and D2a2 measure R and P and lower the constants until it holds.
2. **Mapping by header (C2):** `{source: {header}}` normalized (trimmed, case-insensitive); `{source: {index}}` only when the file has no header row. A saved action re-run whose mapped headers are missing or renamed is refused `422 import.mapping` listing the missing and the unexpected columns; unmapped extra columns are ignored and reported. A dimension that is not in the file can be given a **fixed member** (`mapping.fixed`, e.g. Versions = Budget).
3. **Tokens (I3, I27, V5):** scopes `read` and `read_write`; expiry required (1-365 days, default 90); at most 20 active tokens per user; password change keeps tokens; removal from a workspace removes access through the token (it acts as the user, authorized per request). Session-only (bearer is `403 auth.session_required`): `/me/tokens*`, password change, `/users*`, `POST /workspaces`, `DELETE /workspaces/{id}` and workspace member management (12 routes, one constant). `PATCH /auth/me` (the profile name) is allowed with a `read_write` token.
4. **CSRF layer (I4):** a request authenticated by a bearer header with no session cookie needs no CSRF header (already true; made explicit and tested); a request with a cookie and a bearer is still CSRF-checked; bearer responses never carry `Set-Cookie`. An `Authorization` header whose scheme is not `Bearer` (an HTTP basic-auth gate in front of the app) is ignored, so cookie sign-in keeps working. OpenAPI security becomes two alternative requirements (cookie, bearer) on token-capable routes and the OpenAPI tests accept both.
5. **Shared scaffolding first (I5, V6, V7):** task S0 (wave 0) adds the byte/header/multipart test harness, the axum `multipart` feature, the `ModelAccess<A>` extractor, `auth::READS_BY_POST`, `housekeeping::run_hourly`, the `import/mod.rs` skeleton and the `features/data/api.ts` skeleton, so the wave-1 tasks are parallel. Every shared file is in a hub list.
6. **Migrations (I6):** one migration per server task that creates tables, numbered from `0005` in wave order: `0005_api_tokens.sql` (T1a, wave 1), `0006_pages.sql` (P1, wave 1, merged after T1a), `0007_import_uploads.sql` (D1a2, wave 2), `0008_import_runs.sql` (D2a1, wave 3). The M5 draft renumbers to `0009_*` after M4 merges. FK indexes, stated `ON DELETE` rules, `lower(name)` unique indexes, RLS on every new table.
7. **Models (I7, V11):** D3a, D3b and N1 are Sonnet; **P1 is Sonnet**. Haiku is used for T3 and Z1 only, where the text pins every value.
8. **References (I8, V11):** where an object is *owned* it is deleted with its owner (views with their module, existing). Where it is only *referenced* it is never deleted and never silently dropped. **Pages follow the saved-views precedent: on read, a card whose module, saved view, line item, dimension, action or process no longer exists, and a context entry whose list no longer exists, is pruned from the returned definition and the page says `pruned: true`; the stored definition is not rewritten until the page is saved again.** Actions return `broken: ["<reason>", …]` and refuse to run (`import.mapping`).
9. **Processes (I9, I23, V4):** a process is an ordered list of 1-10 action ids in the structure document with engine-side integrity. A process run **references uploads by id** (one upload per step, made beforehand through the upload route), so its request body is a small JSON of at most 64 KiB.
10. **Files (I10-I14):** `.csv`, `.tsv`, `.txt` (delimited) and `.xlsx` only; **`.xls` (legacy BIFF), `.xlsb`, `.ods` and `.xlsm` are out of scope** (spec change). Uploads: owner and model checked on every lookup, at most 10 pending per user and 200 MiB in all, deleted when a run uses them or after 24 h by the hourly housekeeping loop. `ApiMultipart` gives problem+json rejections and refuses NUL.
11. **Apply (I15):** rows are resolved against an `Arc` snapshot outside the actor; inside `apply_with_answer` the generation is checked and the chunk is re-resolved only if it moved; new items' properties are validated on a scratch clone; duplicates in one file: last row wins, earlier rows are reported as duplicates; a name that matches more than one item is a rejected row unless a code column is mapped. A list chunk holds at most 10,000 items.
12. **Report (I17):** rejected rows kept: the first 10,000 (values trimmed as the count grows so the stored report stays under 8 MiB), with original values and reason, a `rejected_truncated` flag and the true count; `errors.csv` download. `failed` = something was rejected or failed and nothing was applied; `partial` = something applied and something rejected or failed; `succeeded` = nothing rejected and nothing failed (also when every row was blank); `running` while the task works.
13. **Run lifecycle (V3):** the run row (`running`) is written before chunk 1 and its `progress` updated after each chunk; the request waits up to 10 s, then answers `202` with the run id; the client polls `GET /import-runs/{run_id}` every 2 s. A request that is dropped does not stop the run. At server start every `running` row is marked `failed` with the failure `The server restarted while this import was running. Rows applied before that are kept.` No new live message in M4.
14. **Import gate (V2):** `AppState.imports` holds two pools separate from the query `Work` pool: `run` (1 permit, 10 s wait) taken after the request body is fully received and held for the whole run (a process holds it for all its steps), and `read` (2 permits, 10 s wait) for parsing an upload, listing a sheet, `suggest` and `preview`. A wait that times out is `503 server.busy` with `Retry-After`.
15. **Safe files (I18):** CSV text cells starting with `=`, `+`, `-`, `@`, TAB or CR get a leading `'` (plain numbers are exempt); XLSX is written with typed writers only; CSV carries a UTF-8 BOM; file and sheet names are sanitized.
16. **Export (I19):** request carries a `ViewDefinition` and no window; CSV streamed in chunks; XLSX in constant-memory mode with a lower cap; a query `Work` permit for the whole export.
17. **Typed cells (I20):** the value parser lives in the engine with shared test vectors (web and Rust read one JSON file). A blank source cell leaves the value unchanged unless the mapping sets `blank_cells: "clear"`.
18. **Wide files (I21):** a column group maps the header of each column to a member of one dimension (time periods across columns is the main case; versions and list items too). The mapping's `ImportDim` is a real dimension only (list, subset, time, versions) and is spelled like the engine's `ViewDim` (`{"kind":"list","list":…}`).
19. **OpenAPI docs (I22):** a Developer page (`/developers`) links `/api/docs` and shows token usage examples; the module toolbar gets the Export menu (spec §9.3).
20. **Where objects live (I23):** actions and processes: structure document. Pages: table `pages` (the saved-views precedent; spec §6 lists "pages" in the document, so this is recorded as a spec change and as a note for M6: ALM revisions, diff, sync, model copy and `.openplan` must include the `views` and `pages` tables). Pages are editable in production mode (`ProdLock::Ignore`); `suggest` is not in `READS_BY_POST`; E1 and A0 are in wave 0; a bearer plus a session cookie is still CSRF-checked (accepted judgment calls of v2).
21. **Waves (I24):** the wave graph below; every task names its hub files; generated files (`routeTree.gen.ts`, `schema.d.ts`) are regenerated by whichever task lands second, never hand-merged.
22. **Contexts (I26):** a page context selector drives only dimensions that are on a card's *pages*; options come from the dimension's members (the card's subset when the card uses a subset of the list); URL form `?ctx.<ctxKey>=<memberKey>` with `ctxKey` = list id, `time` or `versions`; a context `dim` is spelled like `ViewDimDto` (`{"kind":"list","list":"<uuid>"}`).
23. **Cascade delete:** stand-alone task L2 in wave 1 (server expands descendants into one engine batch; the Lists screen confirms with the count of items removed).
24. **Mode (I33):** URL-driven; `/m/$modelId` redirect picks the landing page from the last mode and the role.
25. **Extractors (V1):** a route with one or more path parameters reads the model id from the segment named `id` (`RawPathParams`), never from a single-value `ApiPath`, which rejects a two-parameter route with `404`. S0 provides `ModelAccess<A>` for that; any other path parameter is read with a second `ApiPath` after it. The Endpoint table names each route's extractor.
26. **Query gate (V9):** the semaphore that keeps a page at four in-flight card queries lives in `use-view-data` (P2a1 edits it), so grid cards go through it; chart and KPI cards use the same gate.
27. **Chart tests (V10):** chart tests assert pure data-shaping functions; the rendering tests stub `ResizeObserver` with a fixed size inside that test file only.
28. **Splits (V12):** every task estimated over about 1,500 lines is split along the seams of the v2 review, with readable ids (D2a1/D2a2, D1a1/D1a2, R1a/R1b, D3a/D3b, T1a/T1b, P2a1/P2a2, P3a1/P3a2, P2b1/P2b2, I1b1/I1b2, I1a1/I1a2); the page action card is its own task (P2c).

**Out of scope for M4:** `.xls`/`.xlsb`/`.ods`/`.xlsm`; a "line item name" column (tall layout); scheduled or URL imports (M16); undoing a whole import as one unit (undo is per chunk); formulas written by an import; a live message for run progress (the client polls).

## Global Constraints

- All M1-M3 Global Constraints and every convention in `CLAUDE.md` apply: problem+json errors, `ApiJson`/`ApiQuery`/`ApiPath`, `Cache-Control: no-store`, snake_case JSON, timestamps RFC 3339, UUID v7 generated in Rust, `sqlx::query`/`query_as` (no `query!` macros), a handler gets its actor from `handle_for` before it reads anything else, model changes are `apply_with`/`apply_with_answer` batches built inside the actor, shadcn-only UI in `web/src/components/ui` (add components with the shadcn CLI, never by hand), the `api`/`unwrap` client, query keys from `web/src/lib/api/keys.ts`, `routeTree.gen.ts` and `schema.d.ts` generated and committed, no commented-out or unused code, no TODO placeholders, conventional commit subjects, commit trailers as given by the session.
- **Roles, locks and extractors.** The Endpoint table is authoritative, including the extractor of each route. Every handler states its role and its `ProdLock`. A route with a large body takes the caller in an extractor of the request head ahead of the body, so a caller below the role is refused (403/404) before the body is read. When the role depends on the body (a list target, `save_as`, a process whose steps include a list import), the head extractor checks Planner and the handler calls `handle_for(…, Builder, ProdLock::Enforce)` **before any parsing, writing or `save_as`**; a planner is never refused after their rows were applied. A route with two path parameters is tested with a valid caller, not only with the refused ones.
- **Migrations.** Each new table: `ENABLE ROW LEVEL SECURITY` (`tests/health.rs` checks it); an index on every foreign key; `ON DELETE` stated (`CASCADE` from `models`, `SET NULL` on `created_by`/`user_id` where history must survive); names unique per model/user as `UNIQUE (…, lower(name))`.
- **Text safety.** Postgres cannot store NUL. Every text taken from a file (cell, header, sheet name, file name) has NUL replaced by U+FFFD at parse time; `ApiMultipart` refuses NUL in text fields and file names (`422 validation`); quoted cell text in reasons is cut at 40 characters (as the grid's `parse-value.ts`), a reason at 200, a stored value at 80, a file name at 200 and stripped of path separators and control characters. A run whose history row cannot be finished is still reported (`warnings`), and a run never depends on its request staying open.
- **Typed cells.** Parsers produce `SourceCell::{Empty, Text, Number, Bool, Date}`; values are parsed by (cell type, line item format) in the engine (task E1). An XLSX number into a percent line item is the fraction (`0.25` is 25%); CSV text `25` or `25%` is percent points (as in the grid).
- **New stable problem codes** (add to the CLAUDE.md list in task Z1): `auth.session_required` 403; `token.not_found` 404; `token.name_taken` 409; `token.limit` 409; `import.upload_limit` 409; `import.too_large` 422; `import.unreadable` 422; `import.mapping` 422; `export.too_large` 422; `page.conflict` 409. Existing codes reused: `payload_too_large` 413 (the existing `AppError::PayloadTooLarge` gains an optional detail), `server.busy` 503, `bad_request` 400, `structure.name_taken` 409, `structure.in_use` 409, `structure.invalid` 422, `model.production_locked` 409, `validation` 422, `not_found` 404, `auth.forbidden` 403 (the read-token refusal uses a detail-carrying constructor).
- **Server acceptance (every server task).** Every new route is in `ApiDoc` `paths(...)` with its schemas in `components(schemas(...))`; multipart request bodies and binary responses are described (`content_type`); each response lists **every code the Endpoint table gives for the route** (including `400`, `503`, `202`); `access_sweep.rs` passes (request schemas must be shaped so the sweep's `example()` can build them: tagged enums as `oneOf`, no top-level `anyOf`/`allOf` on required properties; if one cannot be built extend `example()`, do not simplify the API); `pnpm --dir web gen:api` is run and **`web/src/lib/api/schema.d.ts` is part of every server task's Files and is committed with it**.
- **Web acceptance (every web task).** Every data view has a `Skeleton` loading state, an `EmptyState` (icon, one sentence, primary action) and an `ErrorState` with Retry, and the task's tests cover all three; every mutation button is disabled with a `Loader2` spinner while pending; dialogs that run a mutation ignore Escape and outside clicks while pending (`closeUnlessBusy`); dialogs opened from a menu use `useRestoreFocus()`; forms are react-hook-form + zod + shadcn `Form` with `reportFormError`; feedback by `sonner`; copy is sentence case and buttons start with a verb; controls the user's role cannot use are not rendered (or are disabled with `DisabledReason` when the reason helps); a copy change needs the matching change in any `e2e/tests/*.spec.ts` that asserts it; light and dark screenshots are taken by X1; Recharts and react-grid-layout cannot measure layout in jsdom, so tests assert pure functions and use the stubs each task names.
- **Gates.** Server: `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test -p openplan-server` (with `DATABASE_URL`), `cargo test -p openplan-engine`. Web: `pnpm --dir web lint`, `typecheck`, `test`, `build`. E2E (X1 only): `pnpm --dir web build`, `cargo build -p openplan-server`, `pnpm --dir e2e test`. The `#[ignore]` full-size memory and timing tests run in release in CI (one CI step per file in the `rust` job, each added by the task that creates the file: `--test import_memory` by D1a1 (D1a2 and D1b add cases), `--test export_memory` by D3a (D3b adds cases), `--test import_large` by D2a2, all as `cargo test --release -p openplan-server --test <file> -- --ignored`); a small debug-mode variant of each runs by default.
- **Agent policy (CLAUDE.md).** Implementers never spawn subagents; fixes are new commits (never amend); stage files by explicit path; the implementer writes its report to the file named in its dispatch.

## Review Focus

1. A 100,000-row CSV with 3 bad rows applies the 99,997 good rows in chunks of at most 100,000 cells (each chunk its own change-log batch), records the 3 with row, column, reason and original values, and `errors.csv` lists exactly those rows. Pinned in R1a, D2a1, D2a2, D2b, X1.
2. Changing a page context selector re-queries only the cards whose module has that dimension on its pages; a card whose module lacks it, or has it on rows/columns, is untouched; a page never has more than four card queries in flight. Pinned in P2a1.
3. A bearer token never works for a disabled user, after deletion or expiry, from a cookie, or on session-only routes; never triggers CSRF errors on its own; never receives `Set-Cookie`; a `read` token cannot write. Pinned in T1a, T1b.
4. XLSX with formulas, merged cells, dates (1900 and 1904 systems, serial 60) and percent cells reads values, not formulas, and the percent trap is closed; the XLSX path stays inside the memory budget. Pinned in D1b, E1, R1a, D2a2.
5. Export of a pivoted view with summaries matches the grid (labels, order, raw values); exported text cannot run as a formula; exported data re-imports to the same values. Pinned in D3a, D3b, D2b.
6. A saved action re-run on a file with reordered columns maps correctly; a renamed or missing header is refused `import.mapping`. Pinned in R1a, D2b.
7. A caller below the required role is refused before the body is read; a route with two path parameters works for a valid planner; another user's or model's upload id is `404`. Pinned in S0, D1a2, D2a2, D2b.
8. A 50 MiB upload, a 5,000,000-cell CSV and XLSX, and a run stay inside the derived memory budget; the actor is not stalled by a running import; only one run executes at a time and a second waits then gets `503`. Pinned in D1a1, D1a2, D1b, D2a2.
9. An import run keeps going and saves its history row when the request that started it is dropped; a restart marks unfinished runs failed. Pinned in D2a2.
10. Deleting a module, line item, view or action leaves every page that referenced it loadable, with the affected cards pruned and the page marked `pruned`. Pinned in P1, P2a1.

---

## Wave graph

Merge order inside a wave is the order of the table. A task that lands after another that touched a hub file rebases on it first; `routeTree.gen.ts` and `schema.d.ts` are regenerated (`pnpm --dir web gen:api`, the router plugin through `pnpm --dir web build`), never hand-merged. Wave 0 merges before wave 1, and so on; S0 merges first. **Hub files** are files several tasks edit, each by adding its own lines: server `app.rs`, `lib.rs`, `openapi.rs`, `error.rs`, `extract.rs`, `housekeeping.rs`, `main.rs`, `import/mod.rs`, `auth/mod.rs`, `structure_api.rs`, `views_api.rs`, `Cargo.toml`/`Cargo.lock`, `tests/access_sweep.rs`, `tests/common/mod.rs`, `.github/workflows/ci.yml`; engine `lib.rs`, `command.rs`, `codec.rs`, `structure/mod.rs`, `ids.rs`; web `keys.ts`, `client.ts`, `roles.ts`, `features/data/api.ts`, `features/pages/page-view.tsx`, `card-palette.tsx`, `card-config-sheet.tsx`, `features/grid/use-view-data.ts`, `schema.d.ts`, `routeTree.gen.ts`, `package.json`/`pnpm-lock.yaml`, `components/ui/*`, `build-nav.ts`, `app-sidebar.tsx`, `site-header.tsx`, `model-commands.tsx`, `nav-user.tsx`, `profile-page.tsx`; e2e `helpers.ts`. A pair is "parallel" below when the two tasks share no feature file and only hub files that are merged one at a time.

| Wave | Task | Model | Depends on | Hub files it touches | ~Lines |
|---|---|---|---|---|---|
| 0 | **S0** Harness and shared scaffolding | Sonnet | — | workspace `Cargo.toml`, `tests/common/mod.rs`, `tests/access_sweep.rs`, `structure_api.rs`, `auth/mod.rs`, `main.rs`, `app.rs`, `lib.rs`, `housekeeping.rs`, `import/mod.rs`, `features/data/api.ts`, `e2e/tests/helpers.ts`, `e2e/package.json` | 700 |
| 0 | **E1** Typed-cell value parser (engine) | Sonnet | — | engine `lib.rs`, `structure/list.rs` | 750 |
| 0 | **A0** Actions and processes in the structure document (engine) | Sonnet | — | engine `lib.rs`, `command.rs`, `codec.rs`, `structure/mod.rs`, `ids.rs` | 1,000 |
| 1 | **L2** Cascade delete of list items | Sonnet | S0 | `structure_api.rs`, `openapi.rs`, `schema.d.ts`, `e2e/tests/lists.spec.ts` | 600 |
| 1 | **F1** Web foundations: file transfer, keys, role predicates | Sonnet | S0 | `client.ts`, `keys.ts`, `roles.ts`, `features/data/api.ts` | 450 |
| 1 | **T1a** API tokens: table, CRUD, session-only extractor (server) | Sonnet | S0 | `auth/mod.rs`, `error.rs`, `housekeeping.rs`, `app.rs`, `lib.rs`, `openapi.rs`, `schema.d.ts` | 800 |
| 1 | **D3a** Export core: download helpers, `read_window`, CSV (server) | Sonnet | S0 | `app.rs`, `lib.rs`, `openapi.rs`, `Cargo.toml`, `views_api.rs`, `view_dto.rs`, `query_api.rs`, `auth/mod.rs`, `.github/workflows/ci.yml`, `schema.d.ts` | 900 |
| 1 | **D1a1** CSV reading and the `Sheet` type (server) | Sonnet | E1, S0 | `Cargo.toml`, `import/mod.rs`, `.github/workflows/ci.yml` | 900 |
| 1 | **D1c** Mapping DTO and rules (server) | Sonnet | A0, S0 | `import/mod.rs`, `openapi.rs`, `schema.d.ts` | 900 |
| 1 | **P1** Pages storage and view-by-id (server) | Sonnet | A0, S0 | `app.rs`, `lib.rs`, `openapi.rs`, `views_api.rs`, `schema.d.ts` | 1,500 |
| 2 | **T1b** Bearer authentication, scopes, session-only routes (server) | Sonnet | T1a, S0 | `auth/mod.rs`, `auth/csrf.rs`, `auth/routes.rs`, `users.rs`, `workspaces.rs`, `error.rs`, `openapi.rs`, `schema.d.ts` | 900 |
| 2 | **D3b** XLSX export (server) | Sonnet | D3a | `Cargo.toml`, `export_api.rs`, `openapi.rs`, `schema.d.ts` | 800 |
| 2 | **D1a2** Uploads, multipart extractor, import gate (server) | Sonnet | S0, D1a1 | `app.rs`, `extract.rs`, `error.rs`, `housekeeping.rs`, `import/mod.rs`, `openapi.rs`, `tests/access_sweep.rs`, `schema.d.ts` | 1,200 |
| 2 | **R1a** Row resolution: module rows, list rows, column groups, duplicates, engine check (server) | Sonnet | D1a1, D1c, E1, A0 | `import/mod.rs` | 1,500 |
| 2 | **A1** Actions and processes API (server) | Sonnet | A0, D1c, S0 | `app.rs`, `lib.rs`, `openapi.rs`, `schema.d.ts` | 1,000 |
| 2 | **T2** Tokens screen (web) | Sonnet | T1a, F1 | `profile-page.tsx`, `schema.d.ts` | 800 |
| 2 | **P2a1** Pages in Use mode: shell, list, context selectors, grid card, query gate (web) | Sonnet | P1, F1, D3a, D3b, G4 | `use-view-data.ts`, `grid.tsx`, `page-view.tsx` (created), `routeTree.gen.ts`, `schema.d.ts`, `package.json` | 1,200 |
| 3 | **D1b** XLSX reading and sheet picker (server) | Sonnet | D1a2, D3b, E1 | `Cargo.toml`, `import/mod.rs`, `openapi.rs` | 1,000 |
| 3 | **D1d** Auto-match suggestions (server) | Sonnet | D1a2, D1c, A0 | `import/mod.rs`, `openapi.rs`, `schema.d.ts` | 550 |
| 3 | **R1b** Import preview endpoint (server) | Sonnet | R1a, D1a2 | `import/mod.rs`, `openapi.rs`, `schema.d.ts` | 500 |
| 3 | **D2a1** Import run core: chunk planner, report, run repository (server) | Sonnet | R1a, A0, S0 | migration `0008`, `import/mod.rs` | 1,300 |
| 3 | **D4** Export menu on the module toolbar (web) | Sonnet | D3b, F1, G4 | `schema.d.ts`, `grid-toolbar.tsx` | 350 |
| 3 | **P2a2** Text and image cards (web) | Sonnet | P2a1 | `page-view.tsx`, `package.json` | 600 |
| 3 | **P2b1** Chart card (web) | Sonnet | P2a1 | `page-view.tsx`, `package.json`, `components/ui/chart.tsx` (CLI) | 900 |
| 3 | **P3a1** Page editor: layout, canvas, draft, save, guard, page menu (web) | Sonnet | P2a1 | `page-view.tsx`, `card-frame.tsx`, `package.json` | 1,000 |
| 3 | **T3** Developer page (web) | Haiku | T2, D1a2 | `nav-user.tsx`, `routeTree.gen.ts`, `features/data/api.ts` | 350 |
| 4 | **D2a2** Import run endpoint and lifecycle (server) | Sonnet | D2a1, D1a2, D1b, A0 | `app.rs`, `main.rs`, `import/mod.rs`, `openapi.rs`, `tests/access_sweep.rs`, `.github/workflows/ci.yml`, `schema.d.ts` | 1,400 |
| 4 | **P2b2** KPI card (web) | Sonnet | P2b1 | `page-view.tsx` | 800 |
| 4 | **P3a2** Page editor: add cards, grid/text/image config, page selectors (web) | Sonnet | P3a1, P2a2 | `card-palette.tsx`, `card-config-sheet.tsx` | 1,000 |
| 5 | **D2b** Saved action runs, process runs, history (server) | Sonnet | D2a2, A1, D1b, D1d, D3b | `app.rs`, `import/mod.rs`, `openapi.rs`, `tests/access_sweep.rs`, `schema.d.ts` | 1,400 |
| 5 | **I1a1** Import wizard: shell, upload, target, run and run report; action and process read hooks (web) | Sonnet | D2a2, D1a2, D1d, D2b, A1, F1 | `components/ui/progress.tsx` (CLI), `features/data/api.ts`, `schema.d.ts` | 1,100 |
| 5 | **P3b** Page editor: chart and KPI config (web) | Sonnet | P2b2, P3a2 | `card-palette.tsx`, `card-config-sheet.tsx` | 800 |
| 6 | **I1b1** Actions and import history screens (web) | Sonnet | I1a1, D2b, A1, F1 | `routeTree.gen.ts`, `features/data/api.ts`, `schema.d.ts` | 1,100 |
| 6 | **I1b2** Processes screen (web) | Sonnet | I1a1, D2b, A1 | `routeTree.gen.ts`, `features/data/api.ts`, `schema.d.ts` | 1,000 |
| 7 | **I1a2** Import wizard: map columns, preview, edit mapping, entry points (web) | Sonnet | I1a1, I1b1, R1b, L2, G4 | Lists toolbar, module toolbar, `actions-page.tsx` | 1,300 |
| 7 | **P2c** Page action card (web) | Sonnet | P2a1, P3a2, I1b1, I1b2, A1 | `page-view.tsx`, `card-palette.tsx`, `card-config-sheet.tsx` | 700 |
| 7 | **N1** Build/Use mode and navigation (web) | Sonnet | P2a1, I1b1, I1b2 | `build-nav.ts`, `app-sidebar.tsx`, `site-header.tsx`, `model-commands.tsx`, `routes/_app/m/$modelId/index.tsx` | 900 |
| 8 | **X1** End-to-end suite | Sonnet | all | `e2e/tests/helpers.ts` | 1,300 |
| 8 | **Z1** Docs and conventions | Haiku | all | `CLAUDE.md`, `README.md`, `docs/deploy.md` | 250 |

Critical paths: E1 > D1a1 > D1a2 > D1b > D2a2 > D2b > I1a1 > I1b1 > I1a2 > X1 (the longest), A0 > D1c > R1a > D2a1 > D2a2 (joins the first), I1b1 > N1 > X1, and A0 > P1 > P2a1 > P2b1 > P2b2 > P3b > X1. Two dependencies sit inside a wave and are settled by the order of the table: P2a1 needs D3b (wave 2) and I1a1 needs D2b (wave 5); the later task is dispatched when the earlier one has merged. Feature-disjoint pairs inside a wave (they share only hub files, merged one at a time): (L2, F1), (T1a, D3a), (T1a, D1a1), (D1a1, D1c), (D1a1, D3a), (D1c, P1), (T1b, D3b), (D1a2, R1a), (A1, T2), (D1b, D1d), (R1b, D2a1), (D4, P2a2), (P2b1, P3a1), (P2b2, P3a2), (I1b1, I1b2), (I1a2, N1), (I1a2, P2c), (N1, P2c).

---

## Endpoint table

All paths are under `/api/v1`. **Extractor** is the request-head extractor of the route; `ModelAccess<A>` (task S0) reads the model id from the path segment named `id` and checks the role, so it is the only extractor allowed on routes with more than one path parameter; the other parameter is read afterwards with `ApiPath<(Uuid, Uuid)>`. Markers: `Viewing` (Viewer, `Ignore`), `Planning` (Planner, `Ignore`), `Building` (Builder, `Ignore`), `BuildingLocked` (Builder, `Enforce`). **Role** is the minimum workspace role. **Sweep** is how `tests/access_sweep.rs` treats the route: *read* = a viewer must not get 403 (every GET, and POSTs listed in `auth::READS_BY_POST`); *change* = a viewer must get 403 (every other non-GET); *planner GET* = a GET listed in `PLANNER_ONLY_GETS` (the viewer must get 403, because the answer holds cell values from an import file or report). Outsiders get 404 and anonymous callers 401 on every route under a model.

| Method and path | Task | Extractor | Role | ProdLock | Sweep | Success | Errors (code) |
|---|---|---|---|---|---|---|---|
| `GET /me/tokens` | T1a | `SessionUser` | signed in, cookie only | n/a | not under a model | 200 list | 403 `auth.session_required` |
| `POST /me/tokens` | T1a | `SessionUser` | as above | n/a | not under a model | 201 with the token once | 403 `auth.session_required`; 409 `token.name_taken`, `token.limit`; 422 `validation` |
| `DELETE /me/tokens/{token_id}` | T1a | `SessionUser` + `ApiPath<Uuid>` | as above | n/a | not under a model | 204 | 403 `auth.session_required`; 404 `token.not_found` |
| `POST /models/{id}/export` | D3a (csv), D3b (xlsx) | `ModelAccess<Viewing>` | Viewer | Ignore | read (`READS_BY_POST`) | 200 file | 413 `payload_too_large`; 422 `export.too_large`, `structure.invalid`, `validation`; 503 `server.busy` |
| `POST /models/{id}/lists/{list_id}/items/delete` (changed) | L2 | existing (`CurrentUser`, `handle_for` in the handler) | Builder | Enforce | change | 200 `{deleted}` | 409 `model.production_locked`; 422 `structure.invalid`, `validation` |
| `GET /imports/limits` | D1a2 (D1b adds `max_xlsx_cells`) | `CurrentUser` | any signed-in user; a `read` token may call it | n/a | not under a model | 200 `ImportLimitsDto` | 401 `auth.unauthenticated` |
| `POST /models/{id}/imports/uploads` | D1a2 | `ModelAccess<Planning>`; the `read` gate is taken after the body is received | Planner | Ignore | change | 201 upload | 400 `bad_request`; 409 `import.upload_limit`; 413 `payload_too_large`; 422 `import.unreadable`, `import.too_large`, `validation`; 503 `server.busy` |
| `GET /models/{id}/imports/uploads/{upload_id}?sheet=&has_header=` | D1a2, D1b | `ModelAccess<Planning>` + `ApiPath<(Uuid, Uuid)>` | Planner | Ignore | planner GET | 200 upload | 404 `not_found`; 422 `validation` (unknown sheet), `import.unreadable`, `import.too_large`; 503 |
| `DELETE /models/{id}/imports/uploads/{upload_id}` | D1a2 | as above | Planner | Ignore | change | 204 | 404 `not_found` |
| `POST /models/{id}/imports/uploads/{upload_id}/suggest` | D1d | as above | Planner | Ignore | change | 200 suggestion | 404 `not_found`; 422 `structure.invalid`, `validation`; 503 |
| `POST /models/{id}/imports/preview` | R1b | `ModelAccess<Planning>` | Planner | Ignore | change | 200 preview | 404 `not_found`; 422 `import.mapping`, `import.unreadable`, `structure.invalid`; 503 `server.busy` |
| `POST /models/{id}/imports/run` | D2a2 | `ModelAccess<Planning>`; then `handle_for(Builder, Enforce)` when the target is a list or `save_as` is set; the `run` gate after that | Planner (Builder for a list target or `save_as`) | Ignore for a module target, Enforce otherwise | change | 200 report plus `action_id` (null without `save_as`), or 202 `{run_id, status: "running", progress, action_id}` after 10 s | 403 `auth.forbidden`; 404; 409 `model.production_locked`, `structure.name_taken` (a `save_as` name taken, before anything is applied); 422 `import.mapping`, `validation`; 503 `server.busy` |
| `GET /models/{id}/import-runs/{run_id}` | D2a2 | `ModelAccess<Planning>` + `ApiPath<(Uuid, Uuid)>` | Planner | Ignore | planner GET | 200 run (status, progress, report when finished) | 404 |
| `POST /models/{id}/actions/{action_id}/run` (multipart `file`) | D2b | `ModelAccess<Planning>` + `ApiPath<(Uuid, Uuid)>`; role by the action's target as above | Planner (Builder for a list-target action) | as above | change | 200 or 202 as above | as above; 400; 404 for an unknown action; 413 |
| `POST /models/{id}/processes/{process_id}/run` (JSON `{uploads: [{position, upload_id}]}`, at most 64 KiB) | D2b | `ModelAccess<Planning>` + `ApiPath<(Uuid, Uuid)>`; Builder + Enforce when any step's target is a list, checked before the first step | Planner (Builder for any list-target step) | as above | change | 200 `{run_id, status, steps[]}` or 202 `{run_id, status: "running", progress}` | as above; 413 above 64 KiB |
| `GET /models/{id}/import-runs` | D2b | `ModelAccess<Planning>` | Planner | Ignore | planner GET | 200 list (newest first, 100) | — |
| `GET /models/{id}/import-runs/{run_id}/errors.csv` | D2b | `ModelAccess<Planning>` + `ApiPath<(Uuid, Uuid)>` | Planner | Ignore | planner GET | 200 `text/csv` | 404 |
| `GET /models/{id}/actions` | A1 | `ModelAccess<Viewing>` | Viewer | Ignore | read | 200 | — |
| `GET /models/{id}/actions/{action_id}` | A1 | `ModelAccess<Viewing>` + `ApiPath<(Uuid, Uuid)>` | Viewer | Ignore | read | 200 | 404 |
| `POST /models/{id}/actions` | A1 | `ModelAccess<BuildingLocked>` | Builder | Enforce | change | 201 | 409 `structure.name_taken`, `model.production_locked`; 422 `import.mapping`, `validation` |
| `PATCH /models/{id}/actions/{action_id}` | A1 | `ModelAccess<BuildingLocked>` + `ApiPath<(Uuid, Uuid)>` | Builder | Enforce | change | 200 | as above; 404 |
| `DELETE /models/{id}/actions/{action_id}` | A1 | as above | Builder | Enforce | change | 204 | 409 `structure.in_use` (names the processes), `model.production_locked`; 404 |
| `GET /models/{id}/processes`, `GET …/processes/{process_id}` | A1 | `ModelAccess<Viewing>` (+ `ApiPath` on the second) | Viewer | Ignore | read | 200 | 404 |
| `POST /models/{id}/processes` | A1 | `ModelAccess<BuildingLocked>` | Builder | Enforce | change | 201 | 409 `structure.name_taken`, `model.production_locked`; 422 `structure.invalid` (unknown or too many steps), `validation` |
| `PATCH /models/{id}/processes/{process_id}` | A1 | `ModelAccess<BuildingLocked>` + `ApiPath<(Uuid, Uuid)>` | Builder | Enforce | change | 200 | as above; 404 |
| `DELETE /models/{id}/processes/{process_id}` | A1 | as above | Builder | Enforce | change | 204 | 409 `model.production_locked`; 404 |
| `GET /models/{id}/pages` (summaries) | P1 | `ModelAccess<Viewing>` | Viewer | Ignore | read | 200 | — |
| `GET /models/{id}/pages/{page_id}` | P1 | `ModelAccess<Viewing>` + `ApiPath<(Uuid, Uuid)>` | Viewer | Ignore | read | 200 (with `pruned`) | 404 |
| `POST /models/{id}/pages` | P1 | `ModelAccess<Building>` | Builder | Ignore (pages follow saved views: editable in production mode) | change | 201 | 409 `structure.name_taken`; 413; 422 `validation`, `structure.invalid` |
| `PATCH /models/{id}/pages/{page_id}` | P1 | `ModelAccess<Building>` + `ApiPath<(Uuid, Uuid)>` | Builder | Ignore | change | 200 | 404; 409 `structure.name_taken`, `page.conflict`; 413; 422 |
| `DELETE /models/{id}/pages/{page_id}` | P1 | as above | Builder | Ignore | change | 204 | 404 |
| `POST /models/{id}/pages/reorder` | P1 | `ModelAccess<Building>` | Builder | Ignore | change | 204 | 422 `validation` (ids are not exactly the model's pages) |
| `GET /models/{id}/views/{view_id}` (new, M3 lacks it) | P1 | `ModelAccess<Viewing>` + `ApiPath<(Uuid, Uuid)>` | Viewer | Ignore | read | 200 `ViewDto` | 404 |

**Session-only routes** (`SessionUser`; any `Authorization: Bearer` header is `403 auth.session_required`; the set is one constant in `openapi.rs`, 12 routes, and the tests derive the count from it): `GET`/`POST /me/tokens`, `DELETE /me/tokens/{id}`, `POST /auth/me/password`, `GET`/`POST /users`, `PATCH /users/{id}`, `POST /workspaces`, `DELETE /workspaces/{id}`, `POST /workspaces/{id}/members`, `PATCH`/`DELETE /workspaces/{id}/members/{user_id}`. `PATCH /auth/me` (profile name) and `PATCH /workspaces/{id}` (rename) accept a `read_write` token. `POST /setup` takes no credential and is `409` after the first run, so no token can reach it. Every other route accepts either credential. A `read` token may call GET/HEAD/OPTIONS and the POSTs in `auth::READS_BY_POST` (`/models/{id}/query`, `/members`, `/cells/read`, `/export`, `/live/ticket`); anything else is `403 auth.forbidden` ("This token can only read.").

## Constants (all server limits in one place)

| Constant | Value | Task |
|---|---|---|
| `MAX_UPLOAD_BYTES` | 50 MiB per file; start value, **to be measured** (see Decision 1: `R + 2P <= 310 MB`; lower it and record the measured peak in the doc comment if the release-mode test fails) | D1a1, D1a2 |
| `MAX_FILE_CELLS` | 5,000,000 (rows x columns of the sheet); start value, **to be measured** for CSV (D1a1/D1a2) | D1a1 |
| `MAX_XLSX_CELLS` | starts equal to `MAX_FILE_CELLS`; lowered (start 1,000,000) if the worse of the numeric and the text-heavy XLSX measurements needs it | D1b |
| `MAX_ROWS`, `MAX_COLUMNS` | 1,000,000 data rows; 500 columns | D1a1 |
| Import gate | `run`: 1 permit, 10 s wait; `read`: 2 permits, 10 s wait; both separate from the query `Work` pool (4 permits) | D1a2 |
| `PENDING_UPLOADS_PER_USER`, `PENDING_UPLOAD_BYTES_PER_USER`, `UPLOAD_TTL` | 10; 200 MiB; 24 hours | D1a2 |
| `SAMPLE_ROWS` | 100 (upload sample and preview) | D1a1, R1b |
| XLSX guards | total uncompressed size 200 MiB, 10,000 zip entries, a compression ratio over 1,000 refused only for entries over 16 MiB uncompressed, `xl/sharedStrings.xml` over `MAX_SHARED_STRINGS_BYTES` (start 64 MiB; start value, **to be measured** with the text-heavy fixture) | D1b |
| `CHUNK_CELLS`, `LIST_CHUNK_ITEMS` | 100,000 cells (equals `cells_api::MAX_EDITS`); 10,000 items per list chunk; a row is never split across chunks | D2a1 |
| Rejected rows kept | 10,000 per run; each keeps its row, column and reason (at most 200 characters); values per row: 40 (at most 80 characters each) for the first 1,000 rows, 10 for the next 4,000, none after; the stored report stays under 8 MiB; responses show the first 200 (`rejected_shown`) | D2a1 |
| Run polling and wait | the request waits 10 s for a run, then `202`; the client polls every 2 s | D2a2 |
| `IMPORT_RUNS_KEPT` | newest 500 top-level runs per model (a process row and its step rows count as one); history lists 100 | D2a1, D2b |
| Process | 1-10 steps; run body at most 64 KiB (uploads referenced by id) | A0, D2b |
| Export cells | CSV 2,000,000; XLSX 500,000 (data cells = total rows x total columns); engine windows 1,000 x 200 | D3a, D3b |
| Tokens | name 1-80; expiry 1-365 days (default 90); 20 active per user; `last_used_at` written at most once per 60 s; expired tokens purged 30 days after expiry | T1a, T1b |
| Pages | 100 per model; 40 cards per page; body 1 MiB; text card 20,000 characters; image URL https, at most 2,000 characters; alt 1-200; card title at most 80; action label 1-40; context selectors at most 6; `default_key` 1-100 characters | P1 |
| Chart and KPI windows | 200 rows x 100 columns | P2b1, P2b2 |
| Page query gate | 4 card queries in flight per page | P2a1 |
| Cascade delete | at most 100,000 items per request | L2 |
| Names | actions, processes, pages, tokens: trimmed 1-80, unique per model (per user for tokens) ignoring case | A0, P1, T1a |

## File structure

```
crates/engine/src/input.rs                     SourceCell, parse_cell, Resolver                       (E1)
crates/engine/src/structure/actions.rs         Action, Process, ImportMapping                         (A0)
crates/engine/tests/{input.rs,actions.rs}, tests/fixtures/parse_input.json
crates/server/migrations/{0005_api_tokens,0006_pages,0007_import_uploads,0008_import_runs}.sql
crates/server/src/{model_access.rs,housekeeping.rs,api_tokens.rs,download.rs,export_api.rs,export_xlsx.rs,pages_api.rs,actions_api.rs}
crates/server/src/import/{mod.rs,table.rs,delimited.rs,xlsx.rs,uploads.rs,gate.rs,mapping.rs,suggest.rs,resolve.rs,preview.rs,apply.rs,report.rs,runs.rs,run_api.rs,history.rs}
crates/server/tests/{harness.rs,model_access.rs,api_tokens.rs,api_tokens_bearer.rs,import_csv.rs,import_uploads.rs,import_memory.rs,import_xlsx.rs,import_mapping.rs,import_suggest.rs,import_resolve.rs,import_preview.rs,import_apply.rs,import_run.rs,import_actions_run.rs,import_history.rs,import_large.rs,actions_api.rs,pages_api.rs,export_api.rs,export_xlsx.rs,export_memory.rs}
web/src/lib/api/client.ts                      + uploadFile, downloadFile, saveBlob                   (F1)
web/src/test/charts.ts                         fixed-size ResizeObserver and ResponsiveContainer stub (P2b1)
web/src/features/{tokens,developers,pages,data}/    web/src/features/build/{mode.ts,mode-tabs.tsx,use-sidebar.tsx}   (N1)
e2e/tests/{pages.spec.ts,import-export.spec.ts,tokens.spec.ts,mode.spec.ts,xlsx.ts}
```

---

## Tasks

Each task below is a standalone brief: it names its wave, what it depends on, the hub files it edits, the files it creates or changes, the interfaces it consumes and produces, numbered steps (tests first) and its commit subject. Tasks are listed in merge order. Model names follow the CLAUDE.md agent model policy; where a task says Sonnet it contains design or concurrency work, and Haiku appears only where every value is pinned.

### Task S0: Harness and shared scaffolding (Sonnet)

**Wave 0. Depends on:** nothing. **Hub files:** workspace `Cargo.toml`, `crates/server/tests/common/mod.rs`, `crates/server/tests/access_sweep.rs`, `structure_api.rs`, `auth/mod.rs`, `main.rs`, `app.rs`, `lib.rs`, `housekeeping.rs`, `import/mod.rs`, `web/src/features/data/api.ts`, `e2e/tests/helpers.ts`, `e2e/package.json`. S0 is Sonnet, not Haiku, because it now carries shared server scaffolding as well as the harness; everything it creates is the starting point of lines that wave-1 tasks add to, so no wave-1 task has to create or move a shared file.

**Files:** modify the workspace `Cargo.toml` (`axum = { version = "0.8", features = ["ws", "multipart"] }`), `crates/server/tests/common/mod.rs`, `crates/server/tests/access_sweep.rs`, `crates/server/src/structure_api.rs` (`access_for` becomes `pub(crate)` and `ProdLock` becomes `pub`, because the public `Access` trait names it; otherwise `private_interfaces` fails clippy), `crates/server/src/auth/mod.rs`, `crates/server/src/auth/session.rs` (the hourly loop `purge_expired_periodically` and its private `PURGE_INTERVAL` are removed, the interval moves to `housekeeping`; `purge_expired` stays), `crates/server/tests/auth.rs` (the test `purge_task_clears_expired_sessions_as_soon_as_it_starts` spawns `housekeeping::run_hourly` instead of `session::purge_expired_periodically` and keeps its assertions), `crates/server/src/main.rs`, `crates/server/src/app.rs` (`.merge(import::router())` into the CSRF-protected chain), `crates/server/src/lib.rs`; create `crates/server/src/{model_access.rs,housekeeping.rs}`, `crates/server/src/import/mod.rs`, `crates/server/tests/{harness.rs,model_access.rs}`, `web/src/features/data/{api.ts,api.test.ts}`, `e2e/tests/{xlsx.ts,files-helpers.spec.ts}`; modify `e2e/tests/helpers.ts`, `e2e/package.json` (and the lockfile through `pnpm install`).

**Interfaces — Consumes:** the existing `TestApp`, `Payload`, `TestResponse` (`crates/server/tests/common/mod.rs`); `handle_for`, `access_for`, `ProdLock`, `ModelHandle`, `CurrentUser`, `ApiPath`; `auth::session::purge_expired`; `withApi` (`e2e/tests/helpers.ts`, currently private).

**Interfaces — Produces:**
- **Harness.** `TestResponse` gains `pub bytes: Vec<u8>` (the raw body; `text` stays `from_utf8_lossy`) and `pub fn set_cookies(&self) -> Vec<String>`. `TestApp::anonymous(&self) -> TestApp` (same router, state and pool, empty cookie jar). `TestApp::send_with(&mut self, method: Method, path: &str, content_type: Option<&str>, body: Vec<u8>, headers: &[(&str, &str)], csrf: bool) -> TestResponse` (stored cookies; the `x-openplan-csrf` header from the `op_csrf` cookie when `csrf` is true; the given headers are added last and replace a header of the same name). `TestApp::request_with_headers(&mut self, method: Method, path: &str, body: Option<Value>, headers: &[(&str, &str)]) -> TestResponse`. `TestApp::post_bytes(&mut self, path: &str, content_type: Option<&str>, body: Vec<u8>) -> TestResponse` (CSRF as `post_raw`). `Multipart` builder: `Multipart::new()`, `.text(name, value)`, `.file(name, file_name, content_type, bytes: &[u8])`, `.content_type() -> String` (`multipart/form-data; boundary=…`), `.body() -> Vec<u8>`; `TestApp::post_multipart(&mut self, path: &str, form: Multipart) -> TestResponse` (CSRF as `post_raw`). `post_raw`, `request` and `request_without_csrf` keep working unchanged (they call `send_with`).
- **`model_access.rs` (public, so integration tests can build routes with it):**
  ```rust
  pub trait Access { const ROLE: WorkspaceRole; const LOCK: ProdLock; }
  pub struct Viewing;         // Viewer,  ProdLock::Ignore
  pub struct Planning;        // Planner, ProdLock::Ignore
  pub struct Building;        // Builder, ProdLock::Ignore
  pub struct BuildingLocked;  // Builder, ProdLock::Enforce
  pub struct ModelAccess<A: Access> { pub user: CurrentUser, pub handle: ModelHandle, pub role: WorkspaceRole, pub model_id: Uuid, /* PhantomData<A> */ }
  impl<A: Access> FromRequestParts<AppState> for ModelAccess<A> { type Rejection = AppError; /* … */ }
  ```
  It extracts `CurrentUser`, then the model id from the path segment named `id` with `axum::extract::RawPathParams` (so it works on routes with any number of path parameters; a missing or non-UUID `id` is `404 not_found`, as `ApiPath` answers), then calls `access_for(state, &user, model_id, A::ROLE, A::LOCK)`. A handler that needs another path parameter takes `ApiPath<(Uuid, Uuid)>` after it. It never reads the body.
- `auth::READS_BY_POST: [&str; 4]` (`pub const`, in `auth/mod.rs`): `/api/v1/models/{id}/cells/read`, `/api/v1/models/{id}/query`, `/api/v1/models/{id}/members`, `/api/v1/models/{id}/live/ticket`. Tasks D3a (adds `/export`) and T1b (the read-token check) use it. `access_sweep.rs` imports it instead of its own list and adds `const PLANNER_ONLY_GETS: [&str; 0] = [];` (templates of GETs under a model that need the Planner role; D1a2 and D2a2 append theirs); the sweep treats a route as refused-to-viewer when `(method != GET && !READS_BY_POST.contains(template)) || PLANNER_ONLY_GETS.contains(template)`.
- `housekeeping::run_hourly(db: PgPool)`: calls `auth::session::purge_expired` once as soon as it starts and then every hour (a `tokio::time::interval`, whose first tick is immediate, as the old loop was), and logs a failure to retry next hour; `main.rs` spawns it where it spawned `purge_expired_periodically`. T1a, D1a2 and D2a2 each add one call (token purge, upload purge, nothing for runs; the startup recovery of runs is a separate function called from `main.rs`).
- `import::router() -> Router<AppState>` returning an empty router, merged by `app.rs`, and `pub mod import;` in `lib.rs`; D1a1 adds the submodules, D1a2 and later tasks add `.route(…)` lines.
- `web/src/features/data/api.ts`: `invalidateAfterImport(queryClient: QueryClient, modelId: string, opts: { structure: boolean })` invalidating `queryKeys.query(modelId)` (the grids) and, when `opts.structure`, `queryKeys.structure(modelId)`; F1 adds the run and action keys to it. Every later data hook goes in this file.
- **E2E.** `e2e/tests/helpers.ts`: `withApi` and `ApiClient` exported; `ApiClient` gains `put<T>` and `patch<T>`; `uploadViaApi<T>(baseURL, user, path, file: { field?: string; name: string; mimeType: string; buffer: Buffer }, fields?: Record<string, string>): Promise<{ status: number; body: T }>` (field defaults to `file`; CSRF header added; the status is not asserted); `downloadViaApi(baseURL, user, path, init?: { method?: "GET" | "POST"; data?: unknown }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }>`. `e2e/tests/xlsx.ts`: `readXlsx(buffer: Buffer): Promise<string[][]>` (first worksheet, every cell as a string: numbers `String(n)`, dates `yyyy-mm-dd`, booleans `TRUE`/`FALSE`, empty `""`) using `exceljs ^4.4.0` (devDependency of `e2e`); `readCsv(text: string): string[][]` (strips a leading BOM, RFC 4180 quotes and doubled quotes, `\r\n` or `\n`).

**Steps**
1. `tests/harness.rs`: (a) a `Multipart` with a text field and a file containing the bytes `[0x00, 0xFF, 0x0D, 0x0A, 0x50, 0x4B]` is parsed by a small test router (`axum::extract::Multipart`, so the feature must compile) that returns each field name, file name, content type and byte length; the numbers match; (b) a route that returns the non-UTF-8 bytes `[0xFF, 0xFE, 0x00]` is received unchanged in `TestResponse.bytes`; (c) `request_with_headers` delivers `authorization: Bearer x` to an echo route; (d) after `setup_admin`, `anonymous()` gets `401 auth.unauthenticated` from `GET /api/v1/auth/me` while the original gets 200, both on the same pool; (e) `set_cookies()` of a login response holds `op_session=` and `op_csrf=`; (f) `send_with(…, csrf: false)` omits the CSRF header and a cookie-authenticated POST is `403 auth.csrf`.
2. `tests/model_access.rs` (a test router built in the test with `ModelAccess<A>` for each marker, on `/models/{id}/things` and on the two-parameter `/models/{id}/things/{thing}`): a valid caller of the right role gets 200 on both routes and the second route also reads `thing` through `ApiPath<(Uuid, Uuid)>`; a viewer on a `Planning` route is `403 auth.forbidden`; an outsider is `404`; anonymous is `401`; a non-UUID `id` is `404`; a production-mode model: `Building` and `Planning` pass, `BuildingLocked` is `409 model.production_locked`; a viewer who sends a 60 MiB body to a `Planning` route gets `403`, not `413` (the body was not read).
3. `web/src/features/data/api.test.ts`: `invalidateAfterImport` invalidates the grid queries of the model and not another model's, and the structure only when `structure` is true.
4. `e2e/tests/files-helpers.spec.ts` (no page; runs in the `app` project): `readXlsx` of a workbook built with `exceljs` in the test (a number, a date, a boolean, a text, a blank) returns the strings above; `readCsv` of `\uFEFFa,"b,c","d""e"\r\n1,2,3\r\n` returns `[["a","b,c","d\"e"],["1","2","3"]]`.
5. Implement. `cargo test -p openplan-server --test harness --test model_access --test access_sweep --test auth`, the server gates, the web gates, `pnpm --dir e2e typecheck`.
6. Commit `test: byte, header and multipart harness, model access extractor and shared server scaffolding`.

---

### Task E1: Typed-cell value parser (Sonnet)

**Wave 0. Depends on:** nothing (engine only; it touches no file S0 touches, and D1a1 and R1a need its `SourceCell`; A0 merges after it because both add exports to engine `lib.rs`). **Hub files:** engine `lib.rs`, `structure/list.rs`.

**Files:** create `crates/engine/src/input.rs`, `crates/engine/tests/input.rs`, `crates/engine/tests/fixtures/parse_input.json`, `web/src/features/grid/core/parse-value.shared.test.ts`; modify `crates/engine/src/lib.rs` (exports), `crates/engine/src/structure/list.rs` (`Lookup::resolve`).

**Interfaces — Consumes:** engine `Format`, `Value`, `Structure`, `List`/`Lookup`, `Calendar::{parse_label, month_of_date, period_of_month}`; the web `parse-value.ts` as the behavioural reference for number, boolean and date text.

**Interfaces — Produces (engine, pure, no I/O):**
```rust
pub enum SourceCell { Empty, Text(String), Number(f64), Bool(bool), Date(NaiveDate) }
impl SourceCell {
    pub fn display(&self) -> String;   // "" / the text / shortest decimal without exponent (42, 0.5) / TRUE|FALSE / yyyy-mm-dd
    pub fn is_blank(&self) -> bool;    // Empty, or Text with only whitespace
}
#[derive(Clone, Copy, Default)]
pub struct InputOptions { pub decimal_comma: bool, pub clear_blank: bool }
pub enum Parsed { Skip, Value(Value) }
pub enum Resolved<T> { One(T), Ambiguous, Missing }
pub struct Resolver<'a> { /* structure + one Lookup per list, built on first use */ }
impl<'a> Resolver<'a> {
    pub fn new(structure: &'a Structure) -> Resolver<'a>;
    pub fn item(&mut self, list: ListId, text: &str) -> Resolved<ItemId>;          // name (ignoring case, trimmed) then code; two items of one name is Ambiguous
    pub fn period(&self, text: &str) -> Option<(TimeLevel, u32)>;                    // Calendar::parse_label
    pub fn period_of_date(&self, date: NaiveDate, level: TimeLevel) -> Option<u32>;  // Calendar::month_of_date + period_of_month; None outside the calendar
}
pub fn parse_cell(resolver: &mut Resolver<'_>, format: &Format, cell: &SourceCell, options: InputOptions) -> Result<Parsed, String>;
impl Lookup<'_> { pub fn resolve(&self, text: &str) -> Resolved<u32>; }            // counts duplicate names; codes are unique
```
**Rules** (the web `parseInput` in `web/src/features/grid/core/parse-value.ts` is the reference for number, boolean, date text; messages are identical, quoted text is cut at 40 characters with `…`):

| Format | Cell | Result |
|---|---|---|
| any | blank (`is_blank`) | `clear_blank` false: `Skip`. True: the format's blank value (number 0, boolean false, text empty, date/item/period none) |
| number | `Number(n)` | percent unit: `n` is the fraction (`0.25` is 25%); otherwise `n`. A non-finite number: `'NaN' isn't a number.` |
| number | `Text` | English notation `1,234.50`, `(1,234.50)` negative, leading `-`/`−`/`+`, `25%` (divides by 100), scientific `1.23E+15`, currency symbol in front or code behind (`€12`, `12 EUR`, `$ (1,234.50)`); in a percent unit a bare `25` and `25%` are both 0.25. With `decimal_comma`, `.` groups thousands and `,` is the decimal mark (`1.234,50`). Otherwise `'<text>' isn't a number.` |
| number | `Bool`, `Date` | `'TRUE' isn't a number.` / `'2026-01-31' isn't a number.` |
| boolean | `Bool(b)` | b |
| boolean | `Number` | 0 false, 1 true, else `'2' isn't TRUE or FALSE.` |
| boolean | `Text` | true/1/yes and false/0/no ignoring case, else `'x' isn't TRUE or FALSE.` |
| boolean | `Date` | `'2026-01-31' isn't TRUE or FALSE.` |
| text | `Text` | as is (not trimmed); `Number`/`Bool`/`Date` give `display()` |
| date | `Date(d)` | d |
| date | `Text` | `yyyy-mm-dd` or day-first `dd/mm/yyyy`, validated on the calendar, else `'x' isn't a valid date. Use yyyy-mm-dd or dd/mm/yyyy.`; `Number`/`Bool` give the same message |
| list(L) | `Text`, `Number` | `Resolver::item` on the text (a number uses `display()`); `Ambiguous`: `'x' matches more than one item. Use the code.`; `Missing`: `'x' isn't in this list.` |
| time_period(level) | `Text` | `Resolver::period`; a label of another level: `'x' isn't a quarter.` (level words: month, quarter, half year, year, total); unknown: `'x' isn't a period of this timeline.` |
| time_period(level) | `Date` | the period of `level` containing the date; outside the calendar: `'2031-05-01' is outside the model's timeline.` |

Currency symbols the Rust side knows besides the ISO code (case-insensitive) of the format: USD `$`; EUR `€`; GBP `£`; JPY `¥`; INR `₹`; CNY `¥`, `CN¥`; CAD `$`, `CA$`; AUD `$`, `A$`; MXN `$`, `MX$`; BRL `R$`; KRW `₩`. Any other code is read by its code only.

**Shared vectors:** `parse_input.json` is an array of `{ "name", "format", "cell": {"t": "text"|"number"|"bool"|"date"|"empty", "v"?}, "options"?: {"decimal_comma"?, "clear_blank"?}, "expect": {"value": {"t": "number"|"boolean"|"text"|"date", "v": …}} | {"skip": true} | {"error": "<message>"} }` for the number, boolean, text and date formats (no list or period: those need a model). `format` uses the engine's serde shape (`{"type":"number","decimals":2,"thousands_sep":true,"unit":{"type":"percent"},"negative":"minus"}`). At least 80 cases: plain, grouped, negative sign, parentheses, `−5`, `+5`, `25`/`25%`/`0.25` in percent and plain units, `33.3%`, scientific, `1e21`, currency in front/behind/with parentheses (USD, EUR, GBP, JPY), `decimal_comma` cases, blank with `clear_blank` false and true for every format, boolean words, ISO and day-first dates, `2026-02-30`, `31/04/2026`, typed `number`/`bool`/`date` cells into every format, a 50-character garbage text (message quotes 40 characters and `…`).

**Steps**
1. `tests/input.rs`: runs every vector against `parse_cell` (an empty `Structure` is enough for these formats) and compares the value or message exactly; plus unit tests for `SourceCell::display` (`42`, `0.5`, `1000000`, `-0` is `0`, `TRUE`, `2026-01-31`), list cells (name ignoring case, code, a number used as code, ambiguous names in a numbered list, missing), period cells (every level, wrong level, unknown, date inside and outside the calendar for month/quarter/year), `Lookup::resolve` (one, ambiguous, code).
2. `web/src/features/grid/core/parse-value.shared.test.ts`: reads the same JSON with `readFileSync(new URL("../../../../../crates/engine/tests/fixtures/parse_input.json", import.meta.url))` and runs the vectors the web can express: `cell.t` is `text` or `empty`, `decimal_comma` is absent or false, and for blank cells only `clear_blank: true` (the grid's empty entry is the blank value). Value and message must equal the vector's. If the web disagrees with a vector that encodes shipped M3 behaviour, fix the Rust side; if the web is wrong against spec §9.4, fix the web in a separate commit and say so in the report.
3. Implement; add `pub use input::{InputOptions, Parsed, Resolved, Resolver, SourceCell, parse_cell}` to `lib.rs`.
4. Gates: engine and web.
5. Commit `feat(engine): typed-cell value parser shared with the grid`.

---

### Task A0: Actions and processes in the structure document (Sonnet)

**Wave 0. Depends on:** nothing (engine only; touches no file S0 touches; merge it after E1, because both add exports to engine `lib.rs`). **Hub files:** engine `lib.rs`, `command.rs`, `codec.rs`, `structure/mod.rs`, `ids.rs`.

**Files:** create `crates/engine/src/structure/actions.rs`, `crates/engine/tests/actions.rs`; modify `ids.rs`, `structure/mod.rs`, `command.rs`, `codec.rs`, `lib.rs`.

**Interfaces — Consumes:** `Structure::apply` and the command machinery in `command.rs`, `Model::apply_batch`, the `define_ids!` macro, `EngineError::{Invalid, NameTaken, InUse}`, `StructureDoc` and `rebuild` in `codec.rs`.

**Interfaces — Produces (engine):**
- Ids `ActionId`, `ProcessId` (the `define_ids!` macro, UUID v7).
- Types in `structure/actions.rs`, all `Clone, Debug, PartialEq, Eq, Serialize, Deserialize`, JSON snake_case, `#[serde(deny_unknown_fields)]` on `ImportMapping`:
  - `Action { id: ActionId, name: String, mapping: ImportMapping }` (the only kind of action in M4 is an import).
  - `Process { id: ProcessId, name: String, steps: Vec<ActionId> }`.
  - `ImportMapping { target: ImportTarget, sheet: Option<String> (default null), has_header: bool (default true), decimal: DecimalMark (default dot), blank_cells: BlankCells (default skip), fixed: Vec<FixedMember> (default empty), columns: Vec<ColumnMap> }`.
  - `FixedMember { dim: ImportDim, value: String, match: MatchBy (default name) }`: a dimension that is not in the file gets this member on every row (a list item by name or code, a period by label, a version by name), for example Versions = `Budget`.
  - `ImportTarget`: `{"kind":"list","list_id":…}` | `{"kind":"module","module_id":…}`.
  - `ColumnMap { source: ColumnSource, to: ImportField }`; `ColumnSource`: `{"header":"Region"}` | `{"index":0}` (0-based; only for files without a header row; every message and the wizard show it as `Column {index + 1}`).
  - `ImportField` (`kind` tag): `name`, `code`, `parent`, `property {line_item_id}` (list targets); `dimension {dim: ImportDim, match: "name"|"code" (default name)}`, `line_item {line_item_id}`, `member_values {dim: ImportDim, line_item_id, match (default name)}` (module targets; the header of the column names a member of `dim`, the cell is the value of that line item for the member), `ignore`.
  - `ImportDim` (`kind` tag, spelled like the engine's `ViewDim` and the API's `ViewDimDto`): `{"kind":"list","list":…}` | `{"kind":"subset","subset":…}` | `{"kind":"time"}` | `{"kind":"versions"}`.
  - `DecimalMark`: `"dot"` | `"comma"`; `BlankCells`: `"skip"` | `"clear"`; `MatchBy`: `"name"` | `"code"`.
- `Structure` accessors: `actions()`, `action(id)`, `action_by_name(name)` (ignoring case), `processes()`, `process(id)`, `process_by_name(name)`, `processes_using(action: ActionId) -> Vec<&Process>`.
- Commands: `CreateAction { action: Action }`, `UpdateAction { id, name: Option<String>, mapping: Option<ImportMapping> }`, `DeleteAction { id }`, `CreateProcess { process: Process }`, `UpdateProcess { id, name: Option<String>, steps: Option<Vec<ActionId>> }`, `DeleteProcess { id }`.
- Integrity enforced by the engine: names trimmed, 1-80 characters (`EngineError::Invalid`), unique ignoring case among actions and, separately, among processes (`NameTaken { what: "action" | "process" }`); an action has at most 500 columns (`Invalid`); a process has 1-10 steps, each an existing action (`Invalid`: `Step 2 is not an action of this model.`); deleting an action that a process uses is `InUse` with the message `The action is used by the process 'Month end' and 2 more.` (names up to 3); every new command sets `ChangeSet.structure_changed = true` and changes no line item. (In the engine that flag rebuilds the dependency graph, clears the summary cache and makes the actor publish a `structure_changed` event, so saving an action or process refreshes every open view of the model. That is acceptable because they change rarely; pages avoid it by being a table.) The engine does **not** check that the mapping's list, module, line item or subset ids exist: a deleted target leaves the action stored and the server flags it broken (tasks D1c, A1).
- `StructureDoc` gains `#[serde(default)] pub actions: Vec<Action>` and `#[serde(default)] pub processes: Vec<Process>` (ordered by id); `STRUCTURE_FORMAT` is unchanged and a document without the fields loads; `rebuild` applies `CreateAction` then `CreateProcess` so every check runs on load.

**Steps**
1. `tests/actions.rs`: create, update (rename, replace mapping), delete for both kinds; names unique ignoring case within a kind and equal names across kinds allowed; 81-character and blank names; 501 columns; 11 steps and 0 steps; an unknown step; delete of a used action is `InUse` naming the process, delete after removing it from the process works; one batch (`CreateAction`, `CreateProcess` using it) applies, and a batch whose second command fails leaves neither; `ChangeSet.structure_changed` is true.
2. Codec: export then `Model::from_parts` gives equal actions and processes; a document JSON without `actions`/`processes` loads; a document whose mapping has an unknown field fails to deserialize (the load is refused with an error, never silently accepted); the existing codec tests still pass (only `export_structure` in `codec.rs` builds a `StructureDoc` literal; the tests and the benchmark go through it).
3. Change-log replay: serialize every new `Command` to JSON, replay on a fresh model, same structure.
4. Serde shapes: parse the exact JSON shown above for each `ImportField` kind, each `ImportDim` kind, a `fixed` entry and both `ColumnSource` forms, and round-trip them; `deny_unknown_fields` refuses `{"target":…,"extra":1}`.
5. Implement; export the new items from `lib.rs`.
6. Gates: engine (`cargo test -p openplan-engine`, clippy, fmt) and server compile (`cargo test -p openplan-server --no-run`).
7. Commit `feat(engine): actions and processes in the structure document`.

---

### Task L2: Cascade delete of list items (Sonnet)

**Wave 1. Depends on:** S0. **Hub files:** `structure_api.rs`, `openapi.rs`, `web/src/lib/api/schema.d.ts`, `e2e/tests/lists.spec.ts`.

**Files:** modify `crates/server/src/structure_api.rs` (`delete_items`, `DeleteItemsRequest`), `crates/server/src/openapi.rs` (schema `DeleteItemsResponse`), `crates/server/tests/structure_api.rs`, `web/src/features/lists/{api.ts,hierarchy.ts,hierarchy.test.ts,items-tab.tsx,items-tab.test.tsx}`, `web/src/test/lists.ts` (the fake delete handler), `web/src/lib/api/schema.d.ts`, `e2e/tests/lists.spec.ts`.

**Interfaces — Consumes:** engine `Command::DeleteListItems` (refuses an item while items of a child list have it as parent; a batch of commands applies in order, all or nothing, so deleting the deepest children first works); `handle_for`, `apply_with_answer`.

**Interfaces — Produces:**
- `POST /models/{id}/lists/{list_id}/items/delete` body `{ids: [uuid], cascade: bool (default false)}` returns `200 {deleted: n}` (was `204`; `n` counts the requested items and every descendant). Role Builder, `ProdLock::Enforce`.
- With `cascade: true` the server expands, inside `apply_with_answer` from the model the batch is applied to, the items of every child list (lists whose `parent_list_id` is the list, recursively) whose parent is a deleted item, and emits one `DeleteListItems` per list, deepest list first, in **one batch** (one change-log batch). More than 100,000 items in total: `422 structure.invalid`, `Deleting these items would remove more than 100,000 items.` With `cascade: false` nothing changes: an item with children is still `422 structure.invalid` naming them.
- Web: `hierarchy.ts` gains `descendantsOf(structure, listId, itemIds) -> { total: number; byList: { listId: string; name: string; count: number }[] }` (computed from the structure document; the server's count is authoritative). The delete confirmation on the Lists screen: without descendants the existing dialog; with them the title is `Delete {n} item(s) and {m} child item(s)?`, the description `{m} child items in {Countries and Cities} are deleted too, with all their values in modules. This can't be undone.`, the confirm button `Delete {n+m} items` (destructive, `Loader2` while pending), the success toast `Deleted {n+m} items.`, the failure toast the server's `detail`. The old "blocked by child items" copy is removed.

**Steps**
1. Server tests: Regions > Countries > Cities with data in a module on Cities: deleting two regions with `cascade: true` removes their countries and cities, `deleted` is the sum, the cells on the deleted cities are gone, and the change log advanced by **one** batch; `cascade: false` still `422` with the child names; a second child list at the same level is expanded too; an item not in the list `422`; production mode `409 model.production_locked`; planner and viewer `403`; the expansion function is unit-tested with a limit parameter (a limit of 3 refuses 4 items) and the handler passes 100,000.
2. Web tests: `descendantsOf` for 0, 1 and 2 levels and two child lists; the dialog copy for singular and plural; confirm sends `cascade: true` only when descendants exist; pending spinner and disabled buttons; failure toast; the fake server in `web/src/test/lists.ts` implements `cascade`.
3. `e2e/tests/lists.spec.ts`: replace the assertion on the old blocked copy with the cascade confirmation (delete a region, see the child counts, confirm, the countries are gone).
4. Implement; regenerate `schema.d.ts`.
5. Gates: server and web.
6. Commit `feat: delete list items together with their child items`.

---

### Task F1: Web foundations: file transfer, query keys, role predicates (Sonnet)

**Wave 1. Depends on:** S0. **Hub files:** `web/src/lib/api/client.ts`, `web/src/lib/api/keys.ts`, `web/src/features/workspaces/roles.ts`, `web/src/features/data/api.ts`.

**Files:** modify `web/src/lib/api/client.ts`, `web/src/lib/api/keys.ts`, `web/src/features/workspaces/roles.ts`; modify `web/src/features/data/api.ts` (S0's skeleton) and its test; create `web/src/lib/api/files.test.ts`, `web/src/features/workspaces/roles.test.ts`.

**Interfaces — Consumes:** the existing `addCsrfHeader`, `toApiError` and network middleware of `client.ts`, the `WorkspaceRole` type, the existing `queryKeys`.

**Interfaces — Produces:**
- `client.ts` (shares the module's `addCsrfHeader`, `toApiError`, network mapping; never uses `api`, because `openapi-fetch` sends JSON):
  - `uploadFile<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T>`: `POST /api/v1${path}` with the form as the body (no content-type header, so the browser sets the boundary), the CSRF header, JSON response parsed; a non-2xx response becomes `ApiError` from the problem+json body (`status`, `code`, `detail`, `errors`, `retryAfter`); a fetch that never reaches the server is `ApiError(0, "network", …)`; an abort is rethrown as is.
  - `downloadFile(path: string, init?: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal }): Promise<{ blob: Blob; fileName: string }>`: a `POST` sends `body` as JSON with the CSRF header; `fileName` comes from `Content-Disposition` (`filename*=UTF-8''…` percent-decoded wins over `filename="…"`; with neither, `download`); errors as above (the problem+json is read from the failed response).
  - `saveBlob(blob: Blob, fileName: string): void`: a temporary object URL on an anchor click, revoked afterwards.
- `keys.ts` gains exactly: `tokens: ["tokens"]`; `pages: (modelId) => ["models", modelId, "structure", "pages"]`; `page: (modelId, pageId) => ["models", modelId, "structure", "pages", pageId]`; `view: (modelId, viewId) => ["models", modelId, "structure", "views", viewId]`; `actions: (modelId) => ["models", modelId, "structure", "actions"]`; `processes: (modelId) => ["models", modelId, "structure", "processes"]`; `importRuns: (modelId) => ["models", modelId, "import-runs"]`; `importRun: (modelId, runId) => ["models", modelId, "import-runs", runId]`; `importUpload: (modelId, uploadId, sheet?) => ["models", modelId, "import-uploads", uploadId, sheet ?? null]`; `importLimits: ["import-limits"]`. (Pages, views, actions and processes sit under the structure key so a live `structure_changed` re-reads them and their `pruned`/`broken` flags.)
- `features/data/api.ts`: `invalidateAfterImport` (S0) also invalidates `queryKeys.importRuns(modelId)` and `queryKeys.actions(modelId)`.
- `roles.ts` gains `canEditPages(role)` (builder, admin), `canEditActions(role)` (builder, admin), `canRunImports(role)` (planner, builder, admin), `canImportItems(role)` (builder, admin).

**Steps**
1. `files.test.ts` (msw): `uploadFile` sends `multipart/form-data` with the file and a text field and the `x-openplan-csrf` header read from the `op_csrf` cookie; a `422` problem (`import.unreadable`) rejects with an `ApiError` carrying code, detail and `errors`; a `503` with `Retry-After: 2` sets `retryAfter`; a network failure is `status 0` and code `network`; `downloadFile` returns the blob and `é.csv` from `attachment; filename="a.csv"; filename*=UTF-8''%C3%A9.csv`, `a.csv` from the plain form, `download` from neither; a `POST` download sends the JSON body and the CSRF header; a failed download rejects with the problem's code; `saveBlob` creates and revokes an object URL (stub `URL.createObjectURL` and `revokeObjectURL` in the test; jsdom has neither).
2. `roles.test.ts`: the four predicates for all four roles. `api.test.ts`: `invalidateAfterImport` invalidates the grid queries, the run list and the action list, and the structure only when asked.
3. Implement.
4. Gates: web.
5. Commit `feat(web): file upload and download helpers, M4 query keys and role predicates`.

---

### Task T1a: API tokens: table, CRUD, session-only extractor (server) (Sonnet)

**Wave 1. Depends on:** S0. **Hub files:** `auth/mod.rs`, `error.rs`, `housekeeping.rs`, `app.rs`, `lib.rs`, `openapi.rs`, `web/src/lib/api/schema.d.ts`.

**Files:** create `crates/server/migrations/0005_api_tokens.sql`, `crates/server/src/api_tokens.rs`, `crates/server/tests/api_tokens.rs`; modify `auth/mod.rs` (`SessionUser`), `error.rs` (`AppError::SessionRequired`), `housekeeping.rs` (one call), `app.rs`, `lib.rs`, `openapi.rs` (the `SESSION_ONLY` constant and its tests), `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** `CurrentUser`, `session::lookup`, S0's `anonymous()`, `request_with_headers`, `housekeeping::run_hourly`.

**Interfaces — Produces:**
- Table (migration `0005_api_tokens.sql`, RLS enabled): `api_tokens(id uuid PK, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, name text NOT NULL, scope text NOT NULL CHECK (scope IN ('read','read_write')), token_hash bytea NOT NULL UNIQUE, last_used_at timestamptz, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`; `UNIQUE INDEX api_tokens_user_name_key ON (user_id, lower(name))`; `INDEX api_tokens_user_idx ON (user_id)`.
- Token: `op_pat_` + 32 random bytes as unpadded base64url (43 characters; 50 in all); only the SHA-256 is stored; shown once.
- `GET /api/v1/me/tokens` → `[{id, name, scope, last_used_at, expires_at, created_at}]` (newest first, expired included). `POST /api/v1/me/tokens` `{name (trimmed 1-80), scope: "read"|"read_write" (default "read"), expires_in_days: integer 1-365 (default 90)}` → `201 {id, name, scope, token, expires_at, created_at}`; `409 token.name_taken` (ignoring case, per user); `409 token.limit` ("You have 20 active tokens. Revoke one first.", counted among unexpired tokens inside a transaction that locks the user's row); `422 validation`. `DELETE /api/v1/me/tokens/{token_id}` → `204`; another user's id or an unknown id is `404 token.not_found`.
- `SessionUser(pub CurrentUser)` in `auth/mod.rs`: cookie only. A request with an `Authorization` header whose scheme is `Bearer` is `403 auth.session_required` ("Sign in with your password to do that. API tokens can't manage tokens, passwords, users, workspaces or members."); a header with another scheme is ignored (an HTTP basic-auth gate in front of the app must not break cookie sign-in). New `AppError::SessionRequired` (403, code `auth.session_required`). Used here by the three token handlers; T1b applies it to the other nine session-only routes.
- `openapi.rs`: `pub const SESSION_ONLY: [(&str, &str); N]` of (method, path) pairs, here with the three token routes (T1b completes it to 12); `describe` gives these operations the cookie requirement only and adds `auth.session_required` to their `403` description.
- `api_tokens::purge_expired(db) -> u64` deletes tokens with `expires_at < now() - interval '30 days'`; `housekeeping::run_hourly` calls it.
- `last_used_at`, bearer authentication and scopes are T1b.

**Steps**
1. Lifecycle tests (`tests/api_tokens.rs`): create returns `op_pat_` plus 43 characters once; list never returns it; the stored `token_hash` is 32 bytes and not the token; defaults (`read`, 90 days); `expires_in_days` 0 and 366 `422`; name 81 characters and blank `422`; same name ignoring case `409 token.name_taken`; the 21st unexpired token `409 token.limit` while expired ones do not count; delete own `204`, another user's id and unknown id `404 token.not_found`; deleting a user removes their tokens; anonymous `401`.
2. Session-only: with a valid cookie, `GET /me/tokens` carrying `Authorization: Bearer x` is `403 auth.session_required` (for the three routes and for any value after `Bearer`); the same request with `Authorization: Basic abc` and the cookie is `200`; no `Authorization` header is `200`.
3. Purge: `purge_expired` deletes a token expired 31 days ago, keeps one expired 29 days ago and live ones; `run_hourly` calls it (assert through the function it calls, not by waiting an hour).
4. OpenAPI: the three operations declare only the cookie (and CSRF for mutating) requirement and mention `auth.session_required`; the existing OpenAPI tests still pass.
5. Implement; `pnpm --dir web gen:api` and commit `schema.d.ts`; server gates.
6. Commit `feat(server): personal API tokens, token routes and the session-only extractor`.

---

### Task D3a: Export core: download helpers, `read_window`, CSV (server) (Sonnet)

**Wave 1. Depends on:** S0. **Hub files:** `app.rs`, `lib.rs`, `openapi.rs`, `Cargo.toml` (workspace and crate), `views_api.rs`, `view_dto.rs`, `query_api.rs`, `auth/mod.rs` (one line), `.github/workflows/ci.yml`, `web/src/lib/api/schema.d.ts`.

**Files:** create `crates/server/src/export_api.rs`, `crates/server/src/download.rs`, `crates/server/tests/export_api.rs`, `crates/server/tests/export_memory.rs`; modify `views_api.rs` (`ViewDefinition::to_query`), `view_dto.rs` (make the DTO-to-engine conversions `pub(crate)` as needed), `query_api.rs` (`read_window`), `auth/mod.rs` (append `/api/v1/models/{id}/export` to `READS_BY_POST`, now 5 entries), `app.rs`, `lib.rs`, `openapi.rs`, `Cargo.toml`s (`csv`; D1a1 adds the same dependency, so whichever lands second keeps one line), `.github/workflows/ci.yml` (in the `rust` job, after the engine timing step: `- run: cargo test --release -p openplan-server --test export_memory -- --ignored`; D3b adds its cases to the same test file), `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** S0's `ModelAccess<Viewing>`, `auth::READS_BY_POST`, `anonymous()`; `Work::permit`, `query_api::blocking`, `view::query_with` and `PassingRows`, `ViewDefinition` (`views_api.rs`; its fields stay private, so `to_query` lives in that module).

**Interfaces — Produces:**
- `query_api::read_window(model: &Model, query: &ViewQuery, known: Option<&PassingRows>) -> AppResult<(ViewResult, Option<PassingRows>)>`: the one place both `POST /query` and the export read cells through (M5 puts access filtering here). `POST /query` is changed to call it.
- `ViewDefinition::to_query(&self, module: ModuleId, window: Window) -> AppResult<ViewQuery>`.
- `download.rs`: `attachment(file_name: &str, content_type: &str, body: Body) -> Response` (headers `Content-Type`, `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded>`); `sanitize_file_name(name: &str) -> String` (removes `/ \ : * ? " < > |` and control characters, trims spaces and leading dots, collapses runs of spaces, at most 120 characters, empty becomes `export`); `csv_safe(text: &str) -> Cow<str>` (a text starting with `=`, `+`, `-`, `@`, TAB or CR gets a leading `'`, except a text that is a plain decimal number such as `-5` or `+3.2e4`).
- `POST /api/v1/models/{id}/export` body `ExportRequest { module_id: uuid, definition: ViewDefinition, format: "csv", file_name: Option<String> (at most 120 characters, without extension) }` (`format` is an enum with the single value `csv` here; D3b adds `xlsx`). Extractor `ModelAccess<Viewing>`, `ProdLock::Ignore`, listed in `READS_BY_POST`. Success: the file, `text/csv; charset=utf-8`; default name `<module name> - <yyyy-mm-dd UTC>.csv`, the selected page members appended (`Revenue - Europe, Budget - 2026-10-16.csv`).
- `422 export.too_large` when total rows x total columns exceeds 2,000,000: `This view has {n} cells. CSV exports are limited to 2,000,000 cells. Filter or hide members.` (numbers with thousands commas); `422 structure.invalid` for an unknown module, list, line item or member; `503 server.busy` when no query `Work` permit is free in 10 s.
- **Reading:** after the (small) body is parsed the handler takes one query `Work` permit and moves it into a `spawn_blocking` task. It first reads a 1 x 1 window for `total_rows`, `total_columns`, `row_dims` and `column_dims` (and `PassingRows` when the view has filters, passed as `known` to every later read), applies the cell cap, then reads row blocks of 1,000 and, inside each, column blocks of 200 with `read_window`, assembling whole rows. `collapsed`, `hidden`, `filters`, `show_summaries` and `line_items` of the definition apply, so the file equals the grid.
- **Layout:** one header row per column dimension (in `column_dims` order); the left `row_dims.len()` cells of the header rows are blank except the last header row, which holds the row dimension names (`Regions`, `Time`, `Versions`, `Line items`, or the list/subset name); with no column dimension there is one header row with the row dimension names and the title `Value`; one label column per row dimension (labels repeated on every row); then the cells. Summary members are included when the view shows them. Cells: numbers raw (shortest round-trip decimal, never grouped), booleans `TRUE`/`FALSE`, dates `yyyy-mm-dd`, item and period cells as their `text` (name, label), text as is, flags `na` and `error` blank. **Percent line items** (found through the header member of the `LineItems` dimension, or the page member) are written as percent points with a `%` (`25%`: `value x 100` rounded to 10 decimals, trailing zeros trimmed), so the CSV re-imports to the same value (D2b tests the round trip).
- **CSV:** UTF-8 with a BOM, `\r\n`, fields quoted when they hold `,`, `"`, CR, LF or leading/trailing spaces, every label and text value through `csv_safe`; streamed: a bounded channel of 4 chunks (about 1 MiB each) feeds `Body::from_stream`; the blocking task stops when the receiver is gone and releases the permit.

**Steps**
1. Layout tests (`tests/export_api.rs`): a module Regions > Countries by Time with two line items; rows `[List Regions, LineItems]`, columns `[Time]`, summaries on, a collapsed region: the CSV equals the view read through `POST /query` window by window (labels, order, values, summary rows and columns); a view with two column dimensions has two header rows; no column dimension gives the `Value` header; `hidden` and `filters` apply; the file has the BOM and `\r\n`.
2. Formats: boolean, date, item, period and text line items; blank for `na`; percent as `25%`; a negative number stays `-5`.
3. Safety: a list item named `=HYPERLINK("http://x","y")` and a text value `+1+1` come out as `'=HYPERLINK…` and `'+1+1`; `Content-Disposition` for `file_name` `a"b\nc é` is sanitized, has an ASCII `filename` and a `filename*`; `csv_safe` and `sanitize_file_name` unit tests.
4. Limits: a 130 x 130 x 130 list view (2,197,000 cells) is `422 export.too_large` with the exact sentence; a unit test of the size check with an explicit limit.
5. Access and busy: viewer allowed, planner allowed, outsider 404, anonymous 401; a viewer's export carries the same values as their `POST /query`; with `Work::new(1, 50 ms)` held by another request the export is `503 server.busy` with `Retry-After`; an unknown member is `422 structure.invalid`; `/export` is in `auth::READS_BY_POST` and the access sweep passes.
6. Memory (`tests/export_memory.rs`, allocation counter in the style of `tests/cells_memory.rs`): a small debug-mode case (200,000 cells) runs by default; the full 2,000,000-cell CSV is `#[ignore]` (run in release by CI) and completes with a peak allocation below 150 MB.
7. Implement; add the CI step; `pnpm --dir web gen:api` and commit `schema.d.ts`; server gates.
8. Commit `feat(server): export views to CSV`.

---

### Task D1a1: CSV reading and the `Sheet` type (server) (Sonnet)

**Wave 1. Depends on:** E1, S0 (the `import/mod.rs` skeleton). **Hub files:** `Cargo.toml`, `import/mod.rs`, `.github/workflows/ci.yml`.

**Files:** create `crates/server/src/import/{table.rs,delimited.rs}`, `crates/server/tests/import_csv.rs`, `crates/server/tests/import_memory.rs`; modify `import/mod.rs` (`pub mod table; pub mod delimited;`), `Cargo.toml`s (`csv 1`, `encoding_rs 0.8`), `.github/workflows/ci.yml` (in the `rust` job, after the engine timing step: `- run: cargo test --release -p openplan-server --test import_memory -- --ignored`). No HTTP in this task: the reader is a public library API (`openplan_server::import::table`) tested directly.

**Interfaces — Consumes:** engine `SourceCell` (E1); S0's `import/mod.rs` skeleton.

**Interfaces — Produces:**
- Constants in `import/table.rs` with doc comments recording the measured values (see Constants): `MAX_UPLOAD_BYTES` (50 MiB), `MAX_FILE_CELLS` (5,000,000), `MAX_ROWS` (1,000,000), `MAX_COLUMNS` (500), `SAMPLE_ROWS` (100), and `ACCEPTED_EXTENSIONS: [&str; 3] = ["csv", "tsv", "txt"]` (D1b adds `xlsx`).
- `import::table::Sheet`: a read-only view over the stored bytes. `Sheet::open(kind: SheetKind, bytes: &[u8], sheet: Option<&str>, has_header: bool) -> Result<Sheet, AppError>`; `headers() -> &[String]` (`Column N` when the file has no header row or a header cell is empty), `column_count()`, `row_count()` (data rows), `sheets() -> Vec<String>` (empty for CSV), `rows() -> impl Iterator<Item = Vec<SourceCell>>` (each padded to `column_count()`), `sample(n: usize) -> Vec<Vec<String>>` (the first `n` data rows as `SourceCell::display()` strings padded with "" to `column_count()`), `delimiter() -> Option<char>`, `encoding() -> Option<&'static str>` (`utf-8`, `utf-16le`, `utf-16be`, `windows-1252`), `decimal_hint() -> DecimalHint` (`Comma` for a `;` file, else `Dot`); `Sheet::from_rows(headers: Vec<String>, rows: Vec<Vec<SourceCell>>) -> Sheet` (an in-memory sheet for tests and the preview tests of R1a). A CSV `Sheet` keeps the decoded text and re-parses it on every `rows()` call; it never holds all cells as `SourceCell`s. `SheetKind::{Csv, Xlsx}` and `SheetKind::of_file_name(name) -> Result<SheetKind, AppError>`.
- `check_size(rows: usize, columns: usize) -> AppResult<()>`: `422 import.too_large` "This file has {cells} cells ({rows} rows by {columns} columns). OpenPlan imports at most {MAX_FILE_CELLS} cells, {MAX_ROWS} rows and {MAX_COLUMNS} columns." (every number formatted with thousands commas from the constants, never typed into the message).
- `sanitize_text(&str) -> String` (NUL to U+FFFD), `sanitize_file_name(&str) -> String` (path parts and control characters removed, at most 200 characters).
- Reading rules: UTF-8 (BOM stripped), UTF-16 with BOM (LE/BE, through `encoding_rs`), else valid UTF-8 without BOM, else Windows-1252; NUL replaced by U+FFFD; delimiter sniffed among `,` `;` TAB `|` from the first 20 records (the one that gives the same width > 1 on the most records; ties prefer `,`, `;`, TAB, `|`), a `.tsv` file is always TAB; quoted fields with embedded newlines and doubled quotes; `\r\n`, `\n` and a lone `\r`; blank lines and a trailing blank line skipped; a row longer than the header adds columns named `Column N` (nothing is dropped silently); shorter rows are padded with `Empty`; an empty header cell is `Column N`; headers are trimmed; every non-empty field is `SourceCell::Text`, empty is `Empty`.
- Refusals from `Sheet::open`: extension not in `ACCEPTED_EXTENSIONS` (`.xls`, `.xlsb`, `.ods`, `.xlsm`, `.pdf`, none) `422 import.unreadable` "OpenPlan reads CSV, TSV, TXT and XLSX files. Save the file in one of these formats and try again."; binary content (NUL in more than 1% of the first 64 KiB of a non-UTF-16 file) `422 import.unreadable` "This file looks like a binary file, not a table."; no columns or no data rows `422 import.unreadable` "The file has no data rows."; over the size limits `check_size`.

**Steps**
1. Reading tests (`tests/import_csv.rs`): CSV with BOM; `;` delimiter and `decimal_hint` comma; tab file named `.tsv` and `.txt`; `|` delimiter; quoted newlines and `""`; Windows-1252 accents (`Café` bytes `0x43 0x61 0x66 0xE9`); UTF-16LE with BOM; ragged rows (long row adds `Column 4`, short row padded); empty and duplicate header names; `\r\n`, lone `\r`, trailing blank line; `has_header: false` (the first row is data, headers `Column 1…`); `sample` stops at 100 rows and `row_count` is the true count; a header-only file is `import.unreadable`.
2. Refusals: `.xls`, `.xlsb`, `.ods`, `.xlsm`, no extension, binary bytes, empty file, 501 columns, more than 5,000,000 cells (generated; the message is built from the constants, assert it contains the formatted constants); text safety: NUL inside a cell, a header and a quoted field becomes U+FFFD; `sanitize_file_name` cuts 300 characters to 200 and removes `../`.
3. `tests/import_memory.rs` (allocation counter in the style of `body_memory.rs`): a small debug-mode case (500,000 cells) runs by default; the full-size case (`open`, `row_count`, `sample`, and one full pass of `rows()` over a 50 MiB CSV and a 5,000,000-cell CSV with many short columns) is `#[ignore]`, run in release by CI. **Measure first**, assert the measured peak plus 20%, write the numbers in the doc comments of `MAX_UPLOAD_BYTES` and `MAX_FILE_CELLS` and the Decision-1 inequality, and lower the constants if the peak is above what `R + 2P <= 310 MB` allows (report the final values).
4. Implement; add the CI step; server gates.
5. Commit `feat(server): read delimited files into typed rows`.

---

### Task D1c: Mapping DTO and rules (server) (Sonnet)

**Wave 1. Depends on:** A0, S0 (the `import/mod.rs` skeleton). **Hub files:** `import/mod.rs`, `openapi.rs`, `web/src/lib/api/schema.d.ts`.

**Files:** create `crates/server/src/import/mapping.rs`, `crates/server/tests/import_mapping.rs`; modify `import/mod.rs` (`pub mod mapping;`), `openapi.rs` (schemas), `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** engine `ImportMapping` and friends (A0), `Structure`, `Calendar`.

**Interfaces — Produces:**
- `MappingDto` (and `ColumnMapDto`, `ColumnSourceDto`, `ImportFieldDto`, `ImportDimDto`, `ImportTargetDto`, `FixedMemberDto`) with `ToSchema`, `deny_unknown_fields`, and `From` conversions both ways with the engine types; the JSON is exactly the shape in task A0. Defaults: `sheet` null, `has_header` true, `decimal` `dot`, `blank_cells` `skip`, `fixed` empty. `ImportDimDto` is spelled like `ViewDimDto` (`{"kind":"list","list":"<uuid>"}`, `{"kind":"subset","subset":"<uuid>"}`, `time`, `versions`).
- `pub fn check_mapping(structure: &Structure, mapping: &ImportMapping, file: Option<&FileColumns>, saved: bool) -> Vec<MappingProblem>` with `MappingProblem { field: String, message: String }` (`field` is `target`, `columns`, `columns[i]` or `columns[i].source`), `FileColumns { headers: Vec<String> }`, and `pub fn problems_to_error(problems: Vec<MappingProblem>) -> AppError` (`422 import.mapping`; `detail` is the single message, or `The mapping has {n} problems.`; `errors` lists all). `pub fn broken_reasons(structure, mapping) -> Vec<String>` = the structural rules only, for tasks A1, D2a2 and D2b.
- **Normalization:** `normalize_header(s) = s.trim().to_lowercase()`.
- **Structural rules (no file) and their messages:**
  - S1 `target`: the list or module is gone: `The target no longer exists.`
  - S2 list target, a second column mapped to Name/Code/Parent: `Map only one column to {Name|Code|Parent}.` on the second.
  - S3 list target without Name: `Map a column to Name.`; a numbered list without Code: `This list is numbered, so a column must be mapped to Code.`
  - S4 a list with a parent list and no Parent column: `Map a column to {Parent list name}, because every item needs a parent.`; Parent on a list without a parent list: `{List name} has no parent list.`
  - S5 a `property` line item that is not in the list's properties module (module id equals the list id): `That line item isn't a property of {List name}.`; not input: `{Line item} is calculated, so it can't be imported.`; mapped twice: `That line item is mapped twice.`
  - S6 module target: a `line_item`/`member_values` line item that is not in the module: `That line item isn't in {Module name}.`; calculated and twice: as S5.
  - S7 a `dimension`/`member_values` dim that is not an axis of the module (as the module has it: list, subset, Time, Versions): `{Dim name} isn't a dimension of {Module name}.`; a dim in two `dimension` fields: `Map only one column to {Dim name}.`
  - S8 module target with neither a `line_item` nor a `member_values` column: `Map at least one column to a line item.`
  - S9 an axis of a mapped line item (its `applies_to` or the module's axes; Time unless its `time_scale` is `none`; Versions unless its `versions` is `none`) covered by none of a `dimension` column, the group's dim or a `fixed` member: `Map a column to {Dim name}, or fix its value: {Line item} has it as a dimension.`
  - S10 `member_values` columns with different `dim` or `line_item_id`: `All columns holding values must be for the same line item and dimension.`; together with `line_item` fields: `A file with values across columns holds one line item.`; with `has_header` false: `Values across columns need a header row.`; the group's dim also in a `dimension` field: `{Dim name} is already mapped to a column.`
  - S11 `fixed`: on a list target `Fixed values are for module imports.`; a dim that is not an axis of the module: as S7; a dim fixed twice: `Fix {Dim name} only once.`; a dim that is also in a `dimension` column or the group: `{Dim name} is mapped to a column and also fixed.`; an empty `value`: `Choose a value for {Dim name}.` (whether the value is a member is checked when the file is read, task R1a).
  - S12 `has_header` true with an `index` source: `Use column headers when the file has a header row.`; false with a `header` source: `Use column numbers when the file has no header row.`
  - S13 more than 500 columns: `A mapping holds at most 500 columns.`; the same source twice: `That column is mapped twice.`
- **File rules (with `FileColumns`):** F1 a mapped header is not in the file: `'{header}' isn't a column of the file.`; F2 a mapped header is in the file more than once: `'{header}' appears {n} times in the file. Rename the columns so each is unique.`; F3 an `index` beyond the file: `Column {n} isn't in the file.` (`n = index + 1`) When `saved` is true and F1 or F3 applies, the error `detail` is `The file doesn't match this action. Missing: {headers}. Not in the mapping: {headers}.` (the second sentence only when there are unmapped file columns) and `errors` also holds `{field: "file.columns", message: "Not in the mapping: …"}`. With no F-problem, unmapped file columns are ignored and reported by the caller (`ignored_columns`).

**Steps**
1. `tests/import_mapping.rs`: a table-driven test with one case per rule S1-S13 (including S11) and F1-F3 asserting field and exact message (build the model through the API helpers; delete a list or line item to produce S1/S5/S6); the saved-action variant of F1/F3 with the missing/unexpected detail; `normalize_header` (`" Region "` equals `"region"`).
2. DTO: the A0 example JSON round-trips; an unknown field is `422 validation`; engine/DTO conversions are lossless for every `ImportField` kind.
3. `broken_reasons` returns the S-rule messages and is empty for a valid mapping.
4. Implement; `pnpm --dir web gen:api`; server gates.
5. Commit `feat(server): import mapping DTO and validation rules`.

---

### Task P1: Pages storage and view-by-id (server) (Sonnet)

**Wave 1. Depends on:** A0, S0. **Hub files:** `app.rs`, `lib.rs`, `openapi.rs`, `views_api.rs`, `web/src/lib/api/schema.d.ts`. Sonnet because the pruning rules, the check order and the extractors below are design work even though the values are pinned; about 1,500 lines with tests.

**Files:** create `crates/server/migrations/0006_pages.sql`, `crates/server/src/pages_api.rs`, `crates/server/tests/pages_api.rs`; modify `views_api.rs` (`GET /models/{id}/views/{view_id}`; `ViewDefinition::check` becomes `pub(crate)`), `app.rs`, `lib.rs`, `openapi.rs`, `crates/server/tests/views_api.rs`, `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** S0's `ModelAccess<Viewing>` / `ModelAccess<Building>` (the routes with `{page_id}` also take `ApiPath<(Uuid, Uuid)>`; `pages_api.rs` does **not** reuse `views_api.rs`'s `Reader`/`Writer`, whose helper hard-codes two path parameters); `views_api.rs` (`ViewDto`, the row-to-DTO conversion with its `pruned` flag, `ViewDefinition`); `validate::entity_name`; `ViewDimDto`, `FormatDto`; the engine `Structure` accessors for modules, line items, lists, subsets, actions and processes (A0).

**Interfaces — Produces:**
- Migration (RLS on): `pages(id uuid PK, model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE, name text NOT NULL, definition jsonb NOT NULL, ordinal integer NOT NULL, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`; `UNIQUE INDEX pages_model_name_key ON (model_id, lower(name))`; `INDEX pages_model_ordinal_idx ON (model_id, ordinal)`; `INDEX pages_created_by_idx ON (created_by)`.
- `GET /api/v1/models/{id}/views/{view_id}` → `ViewDto` (same body and `pruned` flag as the list), `ModelAccess<Viewing>` + `ApiPath<(Uuid, Uuid)>`, `404` for an unknown id or a view of another model.
- Routes, extractors and roles per the Endpoint table (Viewer reads; Builder writes; `ProdLock::Ignore`; request body limit 1 MiB; at most 100 pages per model, `422 validation` "A model has at most 100 pages."). A new page gets `ordinal = max + 1`. `POST` body `{name, definition?}` (default `{"context": [], "cards": []}`). `PATCH` body `{name?, definition?, updated_at?}`: `updated_at` (the value from the last read) is **required when `definition` is present** and must equal the stored one, else `409 page.conflict` "Someone else changed this page. Reload it and apply your change again."; a name-only PATCH needs no `updated_at`. `POST /pages/reorder` body `{ids: [uuid]}` must be exactly the model's page ids, else `422 validation`; ordinals become the indexes. Names: trimmed 1-80, unique ignoring case (`409 structure.name_taken`).
- `GET /pages` → `[{id, name, ordinal, card_count, updated_at}]` ordered by ordinal (`card_count` counts the cards after pruning). `GET /pages/{page_id}` → `PageDto {id, name, ordinal, definition, pruned: bool, created_by, updated_at}`.
- **PageDefinition (JSON, unknown fields rejected with `422 validation` naming the field):**
```
{ "context": [ { "dim": {"kind":"list","list":"<uuid>"} | {"kind":"time"} | {"kind":"versions"}, "default_key": "<member key>" | null } ],   // at most 6, no dimension twice, the list must exist
  "cards": [ Card ] }                                                                                                                   // at most 40
Card = { "id": "<uuid>"?, "kind": "grid"|"chart"|"kpi"|"text"|"image"|"action",
         "layout": {"x": 0-11, "y": 0-999, "w": 1-12, "h": 1-40, with x + w <= 12},
         "title": "<=80 chars" | null, "config": <by kind> }
grid   config: {"module_id", "view_id": uuid|null, "view": ViewDefinition|null}   // both set is invalid; neither means the module's default view
chart  config: {"module_id", "view_id"|null, "view"|null, "chart": "bar"|"line"|"area"|"pie"|"combo"|"waterfall", "series": "rows"|"columns", "stacked": bool}
kpi    config: {"module_id", "line_item_id", "selections": [{"dim": ViewDimDto, "key": "<member key>"}], "comparison": {"dim": ViewDimDto, "key": "<member key>"}|null,
                "format_override": FormatDto|null, "sparkline_dim": "time"|null, "inverted": bool}
text   config: {"markdown": "<= 20,000 characters"}
image  config: {"url": "https://… (<= 2,000 characters, host required, no user info)", "alt": "1-200 characters"}
action config: {"target": {"kind":"action","action_id"} | {"kind":"process","process_id"}, "label": "1-40 characters", "confirm": bool}
```
  The page context `dim` and every `dim` inside a card use the same spelling as the query API (`ViewDimDto`: `{"kind":"list","list":"<uuid>"}`, `{"kind":"subset","subset":"<uuid>"}`, `{"kind":"time"}`, `{"kind":"versions"}`); a context `dim` may be a list, `time` or `versions` only. **`default_key`** is a member key as the query API uses it (a list item id, `"top"`, a period label such as `"Jan 26"`, a version id), 1-100 characters, stored as given and **not** validated against the dimension's members on write; the client ignores a key the dimension does not have.
  Card ids are **assigned by the server**: a request card without `id` gets a fresh UUID v7; in a `PATCH` a given `id` must be a card of the stored page (else `422 validation` "That card isn't on this page."); in a `POST` no card may carry an id; ids are unique within a page. The response definition always carries ids.
- **Write checks, in this order per card** (`422 structure.invalid`, field `definition.cards[i].config.<field>`, message; the first failure of each card is reported, cards are checked in order, at most 20 failures are returned and `detail` is the first): (1) the module must exist (`The module doesn't exist.`); (2) `view_id` and `view` together are `422 validation` "Use a saved view or an inline view, not both."; a `view_id` must be a view of this model and of the card's module (`The saved view doesn't exist.` / `The saved view belongs to another module.`); an inline `view` goes through `ViewDefinition::check()` and every list, subset and line item it names must exist and its dimensions must be axes of the module (`The module doesn't have that dimension.` / `The line item doesn't exist.`); (3) a KPI line item must be in the card's module (`The line item isn't in that module.`); (4) KPI `selections`/`comparison` dims must be axes of the module (`The module doesn't have that dimension.`), `line_items` is refused (`A selection can't be on line items.`) and a dimension appears once in `selections`; (5) an action or process target must exist in the model's structure (`The action doesn't exist.` / `The process doesn't exist.`). Context: a list must exist (`The list doesn't exist.`).
- **Pruning on read (the saved-views precedent):** the response omits every card whose module no longer exists, whose `view_id` no longer exists, whose KPI line item no longer exists, whose inline view or KPI selection/comparison names a list, subset or line item that no longer exists or a dimension the module no longer has, or whose action or process no longer exists; it omits every context entry whose list no longer exists; and it sets `pruned: true` when it omitted anything. The stored `definition` is never rewritten by a read (saving the page writes the pruned definition). A card whose saved view exists but was itself pruned by the views API stays.
- Deleting a module (existing handler) already deletes its views; the cards that named them are pruned on the next read. Deleting the model cascades the pages.

**Steps**
1. CRUD tests (`tests/pages_api.rs`): create (default empty definition), list order, get, rename, replace definition, delete, reorder (exact set; missing id; extra id; duplicate), the 101st page `422`, name rules (blank, 81 characters, taken ignoring case `409`), ordinal after delete; **the two-parameter routes (`GET`, `PATCH`, `DELETE` of a page) work for a valid builder and viewer**, `404` for an unknown page id and for another model's page id.
2. Validation, one test per rule above and per field in the schema: bad layout (x + w = 13, w = 0, h = 41, y = 1000), http image, image with user info, 2,001-character URL, empty alt, 20,001-character markdown, 41 cards, 7 context entries, duplicate context dim, unknown list in context, a `subset` context dim, `default_key` of 0 and 101 characters, unknown field at the page, card and config level, both `view_id` and `view`, a view of another module, an inline view naming a deleted list, KPI line item of another module, KPI dim not on the module, `line_items` dim, action and process that do not exist, the check order (a card with a bad module and a bad line item reports the module), card ids (server-assigned on create; unknown id on PATCH; duplicate ids), a 1 MiB + 1 byte body `413`.
3. Conflict: PATCH with a stale `updated_at` `409 page.conflict`; the fresh one succeeds and the response has the new `updated_at`; name-only PATCH without `updated_at` works; `definition` without `updated_at` `422`.
4. Pruning: save a page with a grid card (saved view), a chart (inline), a KPI, an action card and a context entry for a list; then delete, one at a time, the saved view's module, a line item, the action, the process and the list: every read still `200`, the affected cards (and the context entry) are absent and `pruned` is true, unaffected cards stay with the layout unchanged, the stored `definition` is byte-identical after every read; saving the page again with the pruned definition clears `pruned`; a saved view that the views API prunes does not prune its card.
5. Roles: viewer reads (list and one) and gets `403` on every write; planner `403` on writes; builder and admin write; production-mode model: builder can still write (`Ignore`); outsider `404`; the access sweep passes; deleting the model removes its pages.
6. `GET /views/{view_id}`: returns the view, `pruned` as in the list, `404` for another model's view, works for a viewer.
7. Implement; `pnpm --dir web gen:api`; server gates.
8. Commit `feat(server): dashboard pages and view by id`.

---

### Task T1b: Bearer authentication, scopes, session-only routes (server) (Sonnet)

**Wave 2. Depends on:** T1a, S0. **Hub files:** `auth/mod.rs`, `auth/csrf.rs`, `auth/routes.rs`, `users.rs`, `workspaces.rs`, `error.rs`, `openapi.rs`, `web/src/lib/api/schema.d.ts`.

**Files:** modify `auth/mod.rs` (`CurrentUser`), `auth/csrf.rs`, `auth/routes.rs` (`change_password` uses `SessionUser`), `users.rs` (`list_users`, `create_user`, `update_user`), `workspaces.rs` (`create_workspace`, `delete_workspace`, `add_member`, `change_member_role`, `remove_member`), `error.rs` (`AppError::ForbiddenWith(String)`: 403 `auth.forbidden` with that detail), `api_tokens.rs` (`lookup`), `openapi.rs` (security requirements and tests, `SESSION_ONLY` completed to 12), `web/src/lib/api/schema.d.ts`; create `crates/server/tests/api_tokens_bearer.rs`.

**Interfaces — Consumes:** T1a's table, `SessionUser`, `SESSION_ONLY`; S0's `auth::READS_BY_POST`, `anonymous()`, `request_with_headers`, `set_cookies()`.

**Interfaces — Produces:**
- `CurrentUser::from_request_parts`: if an `Authorization` header with scheme `Bearer` (ignoring case) is present it is the only credential: the value must be `Bearer <op_pat_… 50 characters>` else `401 auth.unauthenticated` (never a fall-through to the cookie); the token is found by SHA-256 joined with `users` where `NOT disabled` and `expires_at > now()`, else `401`. A header with another scheme is ignored (the cookie path runs). A `read` token on a request that is not GET/HEAD/OPTIONS and whose matched route template (axum `MatchedPath`; it carries the `/api/v1` nest prefix in axum 0.8, and the scope tests pin that) is not in `auth::READS_BY_POST` is `AppError::ForbiddenWith("This token can only read.")`. `last_used_at` is set to `now()` by `UPDATE … WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`. A bearer request never offers a `SessionRenewal` (no `Set-Cookie`). Without a bearer header the cookie path is unchanged.
- `SessionUser` applied to `change_password`, `list_users`, `create_user`, `update_user`, `create_workspace`, `delete_workspace`, `add_member`, `change_member_role`, `remove_member`. `SESSION_ONLY` holds all 12 (method, path) pairs.
- `auth/csrf.rs`: the rule "an `Authorization: Bearer` request with no `op_session` cookie needs no CSRF header" is explicit in code and tested; a request with both is still checked (`403 auth.csrf` when the header is missing).
- Tokens survive a password change (the Profile copy says so, task T2); a user removed from a workspace loses access through the token at once because every request is authorized as the user.
- OpenAPI: `bearer_token` is an HTTP bearer security scheme (`bearer_format` `op_pat_<random>`); every operation that accepts a token declares **two alternative requirements** (`[{session_cookie}]` or `[{session_cookie, csrf_header}]`, and `[{bearer_token}]`); the 12 session-only operations keep the cookie requirement only and list `403 auth.session_required`. The existing OpenAPI tests are rewritten to accept both shapes.

**Steps**
1. Bearer authentication (`tests/api_tokens_bearer.rs`): `GET /api/v1/auth/me` with only the bearer works; `POST /api/v1/models/{id}/cells` with only the bearer works without a CSRF header; no `Set-Cookie` on any bearer response; expired, deleted and disabled-user tokens `401`; malformed bearer values (`Bearer abc`, `Bearer ` + 50 wrong characters, `Bearer op_pat_`) `401`; invalid bearer plus valid cookie `401`; a valid bearer plus a garbage cookie works; the token as `op_session=` cookie `401`; `Authorization: Basic abc` plus a valid cookie works (the header is ignored); bearer plus session cookie and no CSRF header on a POST `403 auth.csrf`; a user removed from the workspace gets `404` for its model with the same token; a password change keeps the token working; a bearer buys `POST /models/{id}/live/ticket` and the ticket opens the socket.
2. Scopes: a `read` token passes GET, `POST /query`, `/members`, `/cells/read`, `/live/ticket` and gets `403 auth.forbidden` with the detail `This token can only read.` on `POST /cells`, `POST /models`, `DELETE /models/{id}`; the allow-list is `auth::READS_BY_POST` (the same constant the sweep uses); `PATCH /auth/me` with a `read_write` token works and with a `read` token is refused.
3. Session-only: each route of `SESSION_ONLY` (all 12, looped over the constant) with a bearer (`read_write` included) is `403 auth.session_required` and works with the cookie; the constant has 12 entries and equals the Endpoint table's list.
4. `last_used_at`: two requests within a minute write once; backdating the column by 2 minutes makes the next request write again; never-used tokens list `last_used_at: null`.
5. OpenAPI tests updated (`openapi.rs`): `bearer_token` scheme; GET operations that accept tokens declare `[session_cookie]` and `[bearer_token]`; mutating ones `[session_cookie, csrf_header]` and `[bearer_token]`; session-only operations declare one requirement and mention `auth.session_required`; the CSRF description is unchanged; public routes still declare none. CSRF unit tests in `csrf.rs` for the bearer-without-cookie and bearer-with-cookie cases.
6. Implement; `pnpm --dir web gen:api` and commit `schema.d.ts`; server gates.
7. Commit `feat(server): bearer authentication with scopes for personal API tokens`.

---

### Task D3b: XLSX export (server) (Sonnet)

**Wave 2. Depends on:** D3a. **Hub files:** `Cargo.toml`, `export_api.rs`, `openapi.rs`, `web/src/lib/api/schema.d.ts`.

**Files:** create `crates/server/src/export_xlsx.rs`, `crates/server/tests/export_xlsx.rs`; modify `export_api.rs` (`format` gains `xlsx`), `tests/export_memory.rs` (XLSX case), `openapi.rs`, `Cargo.toml`s (`rust_xlsxwriter` with `chrono`; dev-dependency `calamine` with `chrono` to read the written files back; D1b, which lands after this task, turns `calamine` into a normal dependency), `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** D3a's `read_window`, layout assembly, `download::{attachment, sanitize_file_name}`, `ExportRequest`.

**Interfaces — Produces:**
- `ExportRequest.format` accepts `"xlsx"` (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, default name `<module name> - … .xlsx`). The size sentence becomes `This view has {n} cells. CSV exports are limited to 2,000,000 cells and XLSX exports to 500,000. Filter or hide members, or export CSV.` for an XLSX request over 500,000 cells (a CSV request over 2,000,000 keeps the D3a sentence).
- **XLSX:** `rust_xlsxwriter` with `Workbook::add_worksheet_with_constant_memory`; the same layout and reading loop as CSV (rows written in order); sheet name is the module name with `[]:*?/\` removed, at most 31 characters, `Export` when empty; typed writers only (`write_string`, `write_number`, `write_boolean`, `write_datetime`, never `write`), so a text starting with `=` stays a string; dates use the format `yyyy-mm-dd`; **percent line items are written as the fraction with the cell format `0.00%`** (`0.25` shows 25.00%); bold header rows, frozen panes below the header rows and right of the label columns; repeated adjacent labels of a header row are merged (`merge_range`); if the library cannot merge in constant-memory mode, write the repeated labels unmerged and say so in the report. The workbook is built in the blocking task (one query `Work` permit) and sent as a body.

**Steps**
1. Formats (read back with calamine): numbers are `Data::Float`, dates `DateTime`, booleans `Bool`, item and period cells `String`, blank for `na`; percent `0.25` with the `0.00%` format; sheet name sanitized (module `Q1/Q2: [plan]?` becomes `Q1Q2 plan`; 40-character name cut to 31); header merges (merged regions) or the documented fallback; frozen panes.
2. Safety: the item named `=HYPERLINK("http://x","y")` and the text `+1+1` read back as strings (`Data::String`); a negative number stays a number.
3. Limits: a 500,001-cell view is refused for XLSX with the exact sentence and allowed for CSV; the unit test of the size check covers both formats.
4. Equivalence: the XLSX of the layout test's view equals its CSV cell for cell (after reading both back).
5. Memory (`tests/export_memory.rs`): a small debug case (100,000 cells) by default; the full 500,000-cell XLSX is `#[ignore]` (release in CI) and stays below 150 MB peak.
6. Implement; `pnpm --dir web gen:api`; server gates.
7. Commit `feat(server): export views to XLSX`.

---

### Task D1a2: Uploads, multipart extractor, import gate (server) (Sonnet)

**Wave 2. Depends on:** S0, D1a1. **Hub files:** `app.rs`, `extract.rs`, `error.rs`, `housekeeping.rs`, `import/mod.rs`, `openapi.rs`, `tests/access_sweep.rs`, `web/src/lib/api/schema.d.ts`.

**Files:** create `crates/server/migrations/0007_import_uploads.sql`, `crates/server/src/import/{uploads.rs,gate.rs}`, `crates/server/tests/import_uploads.rs`; modify `extract.rs` (`ApiMultipart`), `error.rs` (`AppError::PayloadTooLarge` becomes `PayloadTooLarge(Option<String>)`: `None` keeps today's sentence; update its callers in `extract.rs` and the test in `error.rs`), `app.rs` (`AppState.imports: ImportGate`), `housekeeping.rs` (purge call), `import/mod.rs` (routes, `UploadDto`), `openapi.rs`, `tests/access_sweep.rs` (append `/api/v1/models/{id}/imports/uploads/{upload_id}` to `PLANNER_ONLY_GETS`), `tests/import_memory.rs` (upload-path cases; D1a1 already runs this file in release in CI), `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** D1a1's `Sheet`, constants and refusals; S0's `ModelAccess<Planning>`, `Multipart`, `housekeeping::run_hourly`, `PLANNER_ONLY_GETS`; `Work`.

**Interfaces — Produces:**
- Migration (RLS on): `import_uploads(id uuid PK, model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, file_name text NOT NULL, kind text NOT NULL CHECK (kind IN ('csv','xlsx')), data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`; indexes on `(model_id)`, `(user_id)`, `(created_at)`.
- `ImportGate` (`import/gate.rs`, held as `AppState.imports`): `run: Work` (1 permit, 10 s wait) and `read: Work` (2 permits, 10 s wait), both separate from `AppState.work`. A wait that times out is `503 server.busy` with `Retry-After`. The memory budget assumes one run and two reads at a time (Decision 1).
- `ApiMultipart<R>` in `extract.rs`: rules `R` give the allowed field names (or a prefix such as `file_`), the per-file limit, at most 20 fields, at most 8 KiB per text field. Output `Form { texts: Vec<(String, String)>, files: Vec<FormFile { field, file_name, content_type, bytes: Bytes }> }`. Rejections are problem+json: not multipart `400 bad_request` ("Send the file as multipart/form-data."); malformed `400 bad_request` ("The request isn't valid multipart form data."); unknown field `422 validation` naming it; NUL in a text field or file name `422 validation` ("Text can't contain the NUL character."); file over the limit `PayloadTooLarge(Some("The file is larger than {limit} MB."))` with the limit taken from `MAX_UPLOAD_BYTES`; no file `422 validation` field `file`, "Choose a file.". The file name goes through `sanitize_file_name`.
- Routes (Planner; extractor `ModelAccess<Planning>`, plus `ApiPath<(Uuid, Uuid)>` on the two with `{upload_id}`; see the Endpoint table): `POST /models/{id}/imports/uploads` (multipart field `file`; `DefaultBodyLimit` = `MAX_UPLOAD_BYTES` + 1 MiB; **the `read` permit is taken after the body is received**, then the file is opened with `Sheet::open`, checked and stored); `GET /models/{id}/imports/uploads/{upload_id}` (query `sheet` and `has_header` (default true); a CSV upload has no sheets, so a `sheet` query is `422 validation` "This file has no sheets."; takes a `read` permit); `DELETE /models/{id}/imports/uploads/{upload_id}`.
- `UploadDto { upload_id: uuid, file_name, kind: "csv"|"xlsx", sheets: [string] (empty for CSV), sheet: string|null, has_header: bool, columns: [string], row_count: integer (data rows), sample: [[string]] (`Sheet::sample(100)`), delimiter: ","|";"|"\t"|"|"|null, encoding: string|null, decimal_hint: "dot"|"comma" }`.
- `GET /api/v1/imports/limits` → `ImportLimitsDto { max_upload_bytes, max_file_cells, max_rows, max_columns, pending_uploads_per_user, pending_upload_bytes_per_user }`, each the value of the constant of the same name (D1b adds `max_xlsx_cells`). Extractor `CurrentUser` (any signed-in user; a `read` token may call it); not under a model, so the access sweep does not cover it; `401` for anonymous. The web app reads the upload cap from here and never hard-codes it (task T3).
- `import::uploads`: `store`, `find(db, model_id, user_id, upload_id)` (`WHERE id = $1 AND model_id = $2 AND user_id = $3`, else `NotFound`), `delete`, `pending(db, user_id) -> (count, bytes)`, `purge(db) -> u64` (older than 24 hours); `housekeeping::run_hourly` calls `import::uploads::purge`. A new upload is refused `409 import.upload_limit` ("You have {n} uploads waiting. Finish or discard one before uploading another.") when the user has 10 pending, or `409 import.upload_limit` ("Your waiting uploads would take more than 200 MB. Discard one before uploading another.") when the total with the new file passes 200 MiB.

**Steps**
1. Upload API (`tests/import_uploads.rs`, through the API with `Multipart`): a CSV upload returns the `UploadDto` (columns, sample, `row_count`, `decimal_hint`); `GET` with `has_header=false` shows `Column N` headers and the first row as data; the refusals of D1a1 arrive as 422 problems; 50 MiB + 1 byte is `413` with the detail built from the constant ("The file is larger than {MAX_UPLOAD_BYTES in MiB} MB."); the 11th pending upload and a 201 MiB total are `409 import.upload_limit`; `DELETE` then `GET` is `404`.
2. Ownership and roles: another user's upload id and another model's upload id are `404` on GET and DELETE; **a planner can GET and DELETE their own upload (the two-parameter routes work for a valid caller)**; viewer `403` and outsider `404` **before the body is read** (a viewer who sends a body above the route limit gets `403`, not `413`); planner and builder allowed; the access sweep passes.
3. Gate: with both `read` permits held by other requests a third upload is `503 server.busy` with `Retry-After` while `POST /query` still answers (separate pool); a held `run` permit does not block an upload; permits are given back after an error.
4. Text safety: NUL in a file name or text field `422 validation`; a 300-character file name is cut to 200; `../x.csv` loses its path.
5. `ApiMultipart` tests: unknown field, missing file, wrong content type, malformed boundary, two files, a text field over 8 KiB.
6. Purge: backdate `created_at` by 25 hours and call `purge`: removed; 23 hours: kept; `run_hourly` calls it.
7. Limits: `GET /api/v1/imports/limits` returns the constants (compare each field with the constant), works for a viewer and for a `read` token, and is `401` anonymous.
8. `tests/import_memory.rs` upload-path cases (same debug-small / `#[ignore]` full-size split as D1a1): a 50 MiB CSV upload including the body, the parse and the insert; record the peak P in the doc comment of `MAX_UPLOAD_BYTES`. P alone must stay at or below 100 MB (the run peak R is at least P, so `R + 2P <= 310 MB` cannot hold otherwise); lower `MAX_UPLOAD_BYTES` if it does not. D2a2 adds the run peak R and asserts the full inequality.
9. Implement; `pnpm --dir web gen:api`; server gates.
10. Commit `feat(server): import uploads with a multipart extractor and an import gate`.

---

### Task R1a: Row resolution: module rows, list rows, column groups, duplicates, engine check (server) (Sonnet)

**Wave 2. Depends on:** D1a1, D1c, E1, A0. **Hub files:** `import/mod.rs`. About 1,500 lines with tests: it holds the whole of row resolution (module rows and list rows), so that D2a1 and D2a2 need no other resolution task.

**Files:** create `crates/server/src/import/resolve.rs`, `crates/server/tests/import_resolve.rs`; modify `import/mod.rs` (`pub mod resolve;`). No HTTP in this task.

**Interfaces — Consumes:** `Sheet` and `Sheet::from_rows` (D1a1), `check_mapping`, `normalize_header` (D1c), engine `Resolver`, `parse_cell`, `SourceCell`, `InputOptions` (E1), `ImportMapping` (A0), `Model::canonical_coords`/`check_cells`.

**Interfaces — Produces:**
- Types (public, used by R1b, D2a1 and D2a2): `Problem { column: Option<String>, message: String }` (`column` is the header, or `Column N` without a header row); `ResolvedRow::List(ListRow) | ResolvedRow::Module(ModuleRow)` with `ListRow { item: ItemId, is_new: bool, code: Option<String>, name: String, parent: Option<ItemId>, properties: Vec<(LineItemId, Value)> }` and `ModuleRow { cells: Vec<(LineItemId, Vec<CoordToken>, Value)> }`; `RowOutcome::Ok(ResolvedRow) | Rejected(Vec<Problem>) | Blank`.
- `ModulePlan::new(structure: &Structure, mapping: &ImportMapping, headers: &[String]) -> Result<ModulePlan, AppError>`: runs `check_mapping` with the file (`FileColumns`), resolves each header to a column index with `normalize_header`, resolves the `fixed` members (a list item by name or code, a period by label, a version by name; an unknown or ambiguous value is `422 import.mapping`, field `fixed[i]`, e.g. `'Budgeet' isn't a version.`), and for a column group resolves each group header to a member and refuses a header that is not a member with `422 import.mapping`, field `columns[i].source`, e.g. `'Notes' isn't a period of this timeline.`
- `resolve_module_row(plan: &ModulePlan, resolver: &mut Resolver<'_>, row: usize, cells: &[SourceCell]) -> RowOutcome`.
- `ListPlan::new(structure, mapping, headers) -> Result<ListPlan, AppError>`, `resolve_list_row(plan: &ListPlan, resolver: &mut Resolver<'_>, row: usize, cells: &[SourceCell]) -> RowOutcome`, `ListPlan::key_of` (the code if a Code column is mapped, else the folded name; superseded rows are rejected `Row {n} has the same code and is used instead.` / `Row {n} has the same name and is used instead.`), and the enum `Plan::{Module(ModulePlan), List(ListPlan)}` with `Plan::new(structure, mapping, headers)` and `resolve_row` dispatching to the two. D2a1, D2a2 and the preview (R1b) take a `Plan`.
- **List rows:** Code (trimmed) and Name (trimmed); both empty `Name is empty.` (or `Code is empty.` when only Code is mapped); an existing item is matched by code if the Code column is non-empty, else by name ignoring case (a name shared by more than one item: `'x' matches more than one item. Map a code column.`); Parent resolved with `Resolver::item` in the parent list (`'x' isn't in {Parent list name}.`; empty `Parent is empty.`); a code that is new but whose name belongs to another item: `'x' already names another item.`; properties parsed with the property line item's format and placed at `[Item(item id)]`; a new item gets `ItemId::new()`. New items keep file order.
- `duplicates<K: Hash + Eq>(keys: impl Iterator<Item = (usize, K)>) -> HashMap<usize, usize>`: for each row number that a later row supersedes, the later row number. The key of a module row is the tuple of resolved ids of its `dimension` columns (`ModulePlan::key_of(&ResolvedRow)`); the superseded row is rejected `Row {n} sets the same cells and is used instead.` (column none).
- `engine_check_module(model: &Model, rows: &[(usize, ModuleRow)]) -> AppResult<Vec<(usize, Problem)>>`: groups the cells by line item, runs `Model::canonical_coords` and `Model::check_cells`, and returns one `Problem` per row with an engine issue (the engine's message, column = the value column; this is where a cell before a version's switchover is refused). `check_cells` collects value and switchover issues per edit but stops at the first `InvalidCoordinate`: such an error names its edit by `index`, so that row is rejected and the group is checked again, at most 3 passes; if a coordinate error cannot be attributed to a row, the function returns `Err`, which D2a2 turns into the run's `failure`. The preview (R1b) and D2a1 both call it for a module plan (a list plan's property cells are checked by the run, D2a1), so both refuse the same rows for the same reasons; M5 adds locked cells there as one more per-row reason.
- `row` numbers are the 1-based record numbers of the file (the header record is row 1; the first data row is 2; without a header row the first row is 1).
- **Module rows:** each `dimension` cell is resolved (empty: `{header} is empty.`): a list or subset axis by `Resolver::item` (a subset restricts to its items: `'x' isn't in {Subset name}.`; missing `'x' isn't in {List name}.`; ambiguous with match name `'x' matches more than one item in {List name}. Map a code column.`; match code looks the code up only); Versions by version name ignoring case (`'x' isn't a version.`); Time by label or date. For each mapped line item the coordinates are built in the line item's axis order from the dimension cells and the `fixed` members (a dim the line item does not have is ignored for it); a Time cell becomes `CoordToken::Period(label)` at the line item's own level: a label of another level is `'FY26' is a year, but {Line item} is entered by month.`, a date becomes the period containing it at that level (`'2031-05-01' is outside the model's timeline.` outside the calendar), a Versions cell is `CoordToken::Item(version id)`. Value cells are parsed by `parse_cell` with the line item's format and `InputOptions { decimal_comma: mapping.decimal == comma, clear_blank: mapping.blank_cells == clear }`; `Skip` writes nothing. **Any invalid cell rejects the whole row** (nothing of it is written); the problem names the value column. A row all of whose value cells are skipped is `Blank` (counted, not rejected). Column group: each group column yields a cell for (the group's line item, the row's dimension coordinates plus the column's member).

**Steps**
1. Module rows (`tests/import_resolve.rs`, with `Sheet::from_rows` and a `Model` built through engine commands): dims by name and by code, subset restriction, ambiguous name with and without a code column, missing item, empty dim cell, Time label at the right level / wrong level / unknown / date at month, quarter and year line items / date outside the timeline, Versions, a `fixed` Versions member (and an unknown one `import.mapping`), a line item that lacks a dimension, text/number/boolean/date/list/period line items, **the percent trap** (XLSX-style `Number(0.25)` into a percent line item is 25%; CSV text `25` and `25%` are 25%; text `0.25` is 0.25%), `decimal: comma`, blank skip vs `clear`, a row with one bad cell among three is rejected whole and writes none of the three, an all-blank row is `Blank`, duplicates (earlier row rejected with the sentence), the wide group (months across columns: each column header resolved, cells per column, a non-member header refused `import.mapping`), reordered columns map by header, extra columns reported as ignored, a renamed header refused, `has_header: false` with `index` sources.
2. `engine_check_module`: a cell before the switchover is rejected with the engine's message; a row with an invalid value among several rows rejects only that row; an `InvalidCoordinate` slipped in is attributed to its row and the rest pass; an unattributable one is `Err`.
3. List rows (`tests/import_resolve.rs` plus unit tests in `resolve.rs`): hierarchy with parents by name and by code, properties (number, text, list-valued), numbered list with codes, existing item matched by code and by name, ambiguous name, parent missing/empty, code that names another item, duplicate codes and names in the file (earlier row rejected), blank name, new items in file order, a mapped Code on a non-numbered list, the `Plan::new` and `resolve_row` dispatch for both targets.
4. Implement; server gates.
5. Commit `feat(server): resolve import rows for list and module targets`.

---

### Task A1: Actions and processes API (server) (Sonnet)

**Wave 2. Depends on:** A0, D1c, S0. **Hub files:** `app.rs`, `lib.rs`, `openapi.rs`, `web/src/lib/api/schema.d.ts`.

**Files:** create `crates/server/src/actions_api.rs`, `crates/server/tests/actions_api.rs`; modify `app.rs`, `lib.rs`, `openapi.rs`, `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** engine commands and accessors (A0), `MappingDto`, `check_mapping`, `broken_reasons` (D1c), S0's `ModelAccess<Viewing>` and `ModelAccess<BuildingLocked>` (the routes with `{action_id}` or `{process_id}` also take `ApiPath<(Uuid, Uuid)>`), `apply_with_answer`, `validate::entity_name`.

**Interfaces — Produces** (routes, extractors, roles and codes per the Endpoint table; reads are `Viewing`, writes `BuildingLocked`):
- `ActionDto { id, name, mapping: MappingDto, broken: [string] }` (`broken` = `broken_reasons`, empty when fine); `GET /actions` ordered by name ignoring case. `POST /actions` body `{name, mapping}`: the name is trimmed 1-80; the mapping goes through `check_mapping` (structural rules, no file) and a problem is `422 import.mapping`; the action is created with `Command::CreateAction` and a fresh id; `201 ActionDto`. `PATCH /actions/{action_id}` body `{name?, mapping?}` (same checks). `DELETE` is `409 structure.in_use` when a process uses the action (the engine message names the processes), else `204`.
- `ProcessDto { id, name, steps: [{position: integer (1-based), action_id, action_name}], broken: [string] }` (`broken` holds `Step {n} ({action name}) needs attention.` for every step whose action is broken). `POST /processes` body `{name, steps: [uuid]}` (1-10 steps; an id that is not an action of the model is `422 structure.invalid`, field `steps[i]`, "The action doesn't exist."; the same action may appear twice); `PATCH` body `{name?, steps?}`; `DELETE` `204`. A process run names its uploads by step position (task D2b).
- A deleted list, module, line item or subset leaves every action that named it stored; `GET` flags it through `broken`.

**Steps**
1. CRUD for both kinds through the API, **including the two-parameter routes for a valid builder and viewer**; names (blank, 81 characters, taken ignoring case `409 structure.name_taken`, same name for an action and a process allowed); an invalid mapping on create and on PATCH (S-rule messages, `import.mapping`); steps validation (0, 11, unknown, duplicates allowed); ordering of lists.
2. Broken flags: delete the target list, the module, a mapped line item, a property line item, a subset: `GET` shows the exact S-rule messages and the process shows `Step 2 (Load actuals) needs attention.`; the action is still deletable; a PATCH that fixes the mapping clears `broken`.
3. In use: `DELETE` of an action used by two processes `409 structure.in_use` naming them; after removing the step it succeeds.
4. Production mode: all writes `409 model.production_locked`, reads fine. Roles: viewer reads and gets `403` on writes, planner `403` on writes, builder and admin write; outsider `404`; the access sweep passes.
5. Changes are structure changes: a create produces one change-log batch and a `structure_changed` live event; a model reload (evict, load) returns the same actions and processes.
6. Implement; `pnpm --dir web gen:api`; server gates.
7. Commit `feat(server): actions and processes API`.

---

### Task T2: Tokens screen (web) (Sonnet)

**Wave 2. Depends on:** T1a, F1. **Hub files:** `features/profile/profile-page.tsx`, `schema.d.ts`.

**Files:** create `web/src/features/tokens/{api.ts,tokens-card.tsx,create-token-dialog.tsx,token-secret-dialog.tsx,revoke-token-dialog.tsx}` and their tests (`tokens-card.test.tsx`, `tokens.a11y.test.tsx`); modify `web/src/features/profile/profile-page.tsx` and its test, `e2e/tests/profile.spec.ts` (copy), `schema.d.ts`.

**Interfaces — Consumes:** T1a's routes (`GET/POST /me/tokens`, `DELETE /me/tokens/{token_id}`; the create body is `{name, scope, expires_in_days}`), `queryKeys.tokens`, `relativeTime`, `reportFormError`, `useRestoreFocus`, `closeUnlessBusy`.

**Interfaces — Produces:**
- `useTokens()`, `useCreateToken()`, `useRevokeToken()`. The created token is held in component state only and never enters the query cache (`mutation.reset()` when the secret dialog closes); creating and revoking invalidate `queryKeys.tokens`.
- A third card on the Profile page, shown to every signed-in user. Page description becomes `Your name, password and API tokens.`; the Password card description becomes `Changing it signs you out on every other device. API tokens keep working; revoke them below.`
- Card `API tokens`, description `Tokens let scripts call the API as you, with your role in every workspace. They can't manage tokens, passwords, users, workspaces or members.` and a link `API reference` (`/api/docs`, new tab, `rel="noopener noreferrer"`). `Table` columns: Name, Access (`Read only` / `Read and write`), Created (`relativeTime`), Last used (`relativeTime`, `Never`), Expires (`relativeTime` future wording, or a destructive `Badge` `Expired`), and a Revoke icon button (`aria-label="Revoke {name}"`).
- Empty state: icon `KeyRound`, `No API tokens yet. Create one to call the API from a script.`, primary action `Create token`. Loading: `Skeleton` rows with `role="status"` `aria-label="Loading API tokens"`. Error: `ErrorState` with Retry.
- `Create token` `Dialog` titled `Create API token`: `Name` (1-80), `Access` `Select` (`Read only` default, `Read and write`), `Expires` `Select` (`30 days`, `90 days` default, `1 year`; sends `expires_in_days` 30, 90, 365); buttons `Cancel`, `Create token` (spinner while pending); `409 token.name_taken` shows under Name, `You already have a token with this name.`; `409 token.limit` shows as a destructive `Alert` in the dialog with the server's detail.
- Secret `Dialog` titled `Copy your token`: the sentence `Copy this token now. You won't see it again.`, a read-only `Input` holding the token (select-all on focus), a `Copy token` button (toast `Token copied.`), and a `Button` `I have copied it` that closes the dialog. **Escape and outside clicks do not close it** (the secret would be lost); there is no close icon.
- Revoke `AlertDialog`: title `Revoke {name}?`, description `Scripts that use this token stop working right away. This can't be undone.`, confirm `Revoke token` (destructive, spinner), toast `Token revoked.`

**Steps**
1. `tokens-card.test.tsx` (msw): list renders every column, `Never`, `Expired` badge, access labels; skeleton, empty (with the Create action) and error with Retry (a second GET succeeds); the create flow: fill the form, `POST` body is `{name, scope, expires_in_days}`, the secret dialog shows the returned token once, Copy writes it to the clipboard (stub `navigator.clipboard`), **Escape and an outside click leave the dialog open**, `I have copied it` closes it and the token is nowhere in the document or the query cache afterwards; name taken and limit errors; pending state disables the buttons and ignores Escape in the create dialog; revoke flow with cancel and confirm; a failed revoke toasts the server detail.
2. `profile-page.test.tsx`: the three cards, both new descriptions.
3. `tokens.a11y.test.tsx`: axe on the card, the create dialog and the secret dialog.
4. Update `e2e/tests/profile.spec.ts` for the changed descriptions.
5. Implement; regenerate `schema.d.ts`; web gates.
6. Commit `feat(web): API tokens on the profile page`.

---

### Task P2a1: Pages in Use mode: shell, list, context selectors, grid card, query gate (web) (Sonnet)

**Wave 2. Depends on:** P1, F1, D3a, D3b (the card menu's `/export` call; D3b is in this wave and precedes this task in the table, so it has merged first), M3 G4. **Hub files:** `features/grid/use-view-data.ts`, `features/grid/grid.tsx`, `routeTree.gen.ts`, `schema.d.ts`, `package.json`/`pnpm-lock.yaml`, `page-view.tsx` (created here).

**Files:** create routes `web/src/routes/_app/m/$modelId/pages/index.tsx` and `pages/$pageId.tsx`; `web/src/features/pages/{api.ts,pages-page.tsx,new-page-dialog.tsx,page-view.tsx,page-canvas.tsx,context-bar.tsx,ctx.ts,use-card-query.ts,query-gate.ts,card-frame.tsx,card-definition.ts,types.ts}` and `cards/{grid-card.tsx,unavailable-card.tsx,card-states.tsx}` with tests; modify `web/src/features/grid/use-view-data.ts` and `grid.tsx` (and their tests) for the query gate, `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** P1's routes and `PageDto`/`PageSummaryDto`/card types from `schema.d.ts`; `GET /models/{id}/views/{view_id}` (P1) and the module's views list (G4's `useSavedViews`, G4 name); `POST /members`, `POST /query`; the `Grid` component (`features/grid/grid.tsx`: props `modelId`, `query`, `label`, `readOnly`, `reference`, `onSelectLineItem`) and `gridReference`; `defaultPivot`; G4's `queryOf` (definition to query, in `view-state.ts`; G4 name); `downloadFile`, `saveBlob` (F1); `canEditPages` (F1); `queryKeys.pages/page/view`.

**Interfaces — Produces:**
- `pagesQuery(modelId)` and `pageQuery(modelId, pageId)` (query options, so `beforeLoad` in task N1 can `ensureQueryData` them), `usePages(modelId)`, `usePage(modelId, pageId)` and `useCreatePage` in `api.ts`; types `PageDto`, `Card` (a union by `kind`), `CardLayout`.
- **Routes:** `/m/$modelId/pages` (list) and `/m/$modelId/pages/$pageId` (a page). Their search validator keeps every `ctx.<ctxKey>` parameter (and `edit`, used by P3a1). **All `/m/$modelId/pages*` routes are Use-mode routes** (task N1 derives the mode from the URL).
- **Pages list** (`PageHeader` `Pages`, description `Dashboards built from your model's data.`): `Table` of Name (link), Cards, Updated (`relativeTime`); `New page` button for `canEditPages(role)` opens a `Dialog` (`New page`, field `Name`, button `Create page`) and navigates to the new page; empty state: icon `LayoutDashboard`, `No pages yet. Pages show a model's numbers as cards.`, primary action `New page` for builders and admins (nothing for others); skeleton and `ErrorState`.
- **Page view:** `PageHeader` with the page name; for `canEditPages(role)` and `pruned: true` a `status` `Alert`: `Some cards were removed because what they showed no longer exists. Edit and save the page to remove them for good.`; a sticky `ContextBar` under it when the page has selectors; a 12-column grid of cards (`PageCanvas`: CSS grid, `grid-auto-rows: 80px`, gap 16 px, each card at `grid-column: x+1 / span w`, `grid-row: y+1 / span h`; below 768 px (`use-mobile`) one column in (y, x) order, each card `h x 80` px tall); an unknown page id shows an `EmptyState` `This page doesn't exist.` with a link to the list; skeleton cards while loading; `ErrorState` with Retry. `page-view.tsx` switches on the card `kind`: this task renders `grid`; every other kind renders `UnavailableCard` (a card frame with a muted `Alert` `This card type isn't available yet.`), which the tasks that add those kinds replace one by one (P2a2 text and image, P2b1 chart, P2b2 KPI, P2c action; P2c deletes `unavailable-card.tsx`).
- **Card frame** (`Card` with a title row and a `DropdownMenu` kebab): `Open in module` (grid cards; link to `/m/$modelId/modules/$moduleId` with `?view=<id>` when the card has a saved view), `Export as CSV` / `Export as XLSX` (grid cards; `POST /export` with the card's **effective** definition, after context overrides, through `downloadFile`/`saveBlob`; toast the server detail on failure); loading `Skeleton`, empty and error states with Retry per card.
- **Context selectors (I26):** `ctx.ts` exports `ctxKey(dim)` (the list id, `time` or `versions`; not G4's `dimKey`, which returns `list:<id>`), `readContext(search)` and `writeContext(search, ctxKey, key)` for the URL form `?ctx.<ctxKey>=<memberKey>` (written with `replace`; unknown or malformed values are ignored silently). `applyContext(query: GridQuery, selectors, values, structure): GridQuery` is **pure**: for each selector with a value it replaces the `key` of the query's page selection whose dimension matches (the same list; a subset of that list when the chosen member belongs to the subset; `time`; `versions`) and leaves a dimension that is on the query's rows or columns untouched; a module without the dimension is untouched. The query key of a card is `queryKeys.query(modelId, pivot-after-override, block)`, so only cards whose pivot changed re-query. The bar shows one control per selector: `Select` when the dimension has at most 20 members, otherwise a searchable `Popover` + `Command`; label is the list name, `Time` or `Versions`; the options come from `POST /members` for the first card (layout order) whose module has the dimension on its pages (that card's subset when it uses one; otherwise the list); no value means `Card default` and the cards keep their own selection; the value is the URL's, else `default_key` (ignored when the dimension has no such member), else none; a selector no card uses is disabled with `No card on this page uses {label}.`; a chosen member that is not in a card's subset leaves that card on its own selection with the note `Not in this card's subset.`
- **Query resolution** (`use-card-query.ts`): base definition = the card's inline `view`, else `GET /views/{view_id}` (a `pruned` view shows the note `Some items of this view no longer exist.`), else the module's default saved view, else `defaultPivot(module)`; converted with G4's `queryOf`, then `applyContext`.
- **Query gate (V9):** `query-gate.ts` exports `createQueryGate(limit: number)` returning `run<T>(work: () => Promise<T>): Promise<T>`, a semaphore that lets at most `limit` run at once, in arrival order. `PageView` creates one gate of **4** (the server's query `Work` permits) and provides it through a React context (`usePageGate()`); `use-view-data.ts` takes an optional `gate` and wraps its `queryView` call in `gate.run`; `Grid` gets an optional `gate` prop passed to it; chart and KPI cards (P2b1, P2b2) use the same gate through `usePageGate()`. A `503 server.busy` is shown inside that card with its Retry (using `retryAfter`) and the other cards stay rendered. Card queries use `staleTime` 30 s and `refetchOnWindowFocus: false`.
- **Grid card:** `<Grid … readOnly={role === "viewer"} gate={gate}>` filling the card body (a viewer cannot edit, a planner and above edit like the module grid).

**Steps**
1. Pure tests: `ctx.ts` round trip and bad input; `applyContext` for a page dimension (list, subset of the list, time, versions), for a dimension on rows or columns, for a module without the dimension, for a missing key; `card-definition.ts` (query to definition); `createQueryGate` (limit respected, order, a rejected work item releases its slot).
2. **Gate (Review Focus 2):** six grid cards on one page, each query held by an msw handler that counts concurrent requests: never more than 4 in flight, and all six render; `use-view-data.test.tsx` covers the `gate` option (absent gate behaves as before).
3. Context (msw, two cards on one page): card A's module has Regions on its pages, card B's module has none; changing the Regions selector re-queries A only (count `POST /query` per module); the URL has `ctx.<listId>`; a reload with the URL restores the value; a malformed `ctx` is ignored; select vs searchable control at 20 and 21 members; `Card default`; disabled selector with the reason; members come from the first card that has the dimension on its pages; subset note.
4. Cards and page: grid card read-only for a viewer and editable for a planner; `UnavailableCard` for the other kinds; per-card skeleton, empty, error + Retry, `503` on one card leaves the others rendered and retries after `retryAfter`; pages list states (skeleton, empty with and without the action by role, error), New page dialog (validation, `409 structure.name_taken` under Name, spinner), unknown page, mobile order, the `pruned` notice for builders only, card export request body carries the context overrides.
5. Implement; regenerate `schema.d.ts` and the route tree; web gates.
6. Commit `feat(web): dashboard pages in use mode with page selectors and a query gate`.

---

### Task D1b: XLSX reading and sheet picker (server) (Sonnet)

**Wave 3. Depends on:** D1a2, D3b (its `rust_xlsxwriter` dependency and the `calamine` dev-dependency), E1. **Hub files:** `Cargo.toml`, `import/mod.rs`, `openapi.rs`.

**Files:** create `crates/server/src/import/xlsx.rs`, `crates/server/tests/import_xlsx.rs`; modify `import/table.rs` (`ACCEPTED_EXTENSIONS` gains `xlsx`; dispatch; `MAX_XLSX_CELLS`, `MAX_SHARED_STRINGS_BYTES`), `import/mod.rs` (the GET handler reads `?sheet=`; `ImportLimitsDto` gains `max_xlsx_cells`), `tests/import_memory.rs` (XLSX cases), `Cargo.toml`s (`calamine 0.36` with `chrono` becomes a normal dependency of the server crate, having been a dev-dependency since D3b; `zip`; `rust_xlsxwriter` is already a dependency from D3b and is used for fixtures), `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** D1a1's `Sheet`, `SheetKind`, constants, `check_size`; D1a2's upload routes and `ImportGate`; engine `SourceCell` (E1).

**Interfaces — Produces:**
- `.xlsx` joins `ACCEPTED_EXTENSIONS` (`.xls`, `.xlsm`, `.xlsb`, `.ods` stay refused with the D1a1 sentence). The reader opens with `calamine::Xlsx::new` (never the auto-detecting opener) inside `spawn_blocking` with `std::panic::catch_unwind`; a panic or a calamine error is `422 import.unreadable` "The workbook is damaged or uses a feature OpenPlan can't read."
- Zip guards before any sheet is read (central directory read with the `zip` crate): total uncompressed size over 200 MiB, more than 10,000 entries, or an entry larger than 16 MiB uncompressed whose compression ratio is over 1,000 is `422 import.unreadable` "This workbook is larger than it looks once unpacked.". (Ordinary sheet XML compresses past 100:1, so small entries are not judged by ratio; the total-size guard bounds a bomb.) **A shared-strings guard** reads the uncompressed size of `xl/sharedStrings.xml` from the same directory: over `MAX_SHARED_STRINGS_BYTES` (start 64 MiB; set from the text-heavy measurement in step 5) is `422 import.unreadable` "This workbook holds more text than OpenPlan can read. Save the data as CSV and import that.". It exists because `calamine::Xlsx::new` loads the whole shared-strings table into memory whatever the cell reader does, so the streaming reader alone does not bound memory for a workbook of distinct text.
- Sheets are read by **streaming** cells (`Xlsx::worksheet_cells_reader` or the equivalent in 0.36; verify with `cargo doc`), never `worksheet_range`, which allocates the declared dimension at once. `Sheet::open` for XLSX makes one counting pass (rows, columns, populated cells; stops with `422 import.too_large` as soon as rows x columns of the populated area would exceed `MAX_XLSX_CELLS`, 1,000,000 rows or 500 columns) that also keeps the first 100 rows for the sample; `rows()` streams the sheet again, so the upload `GET` (sample and count) never holds the whole sheet and only preview and run read all rows, one pass at a time. `MAX_XLSX_CELLS` starts equal to `MAX_FILE_CELLS` and is lowered (start 1,000,000) if the XLSX measurement needs it.
- `UploadDto.sheets` lists the visible worksheets in order (hidden sheets and chart sheets are left out); `sheet` is the one read (the first by default); `GET …/uploads/{upload_id}?sheet=Budget` returns that sheet's `columns`, `sample` and `row_count`; an unknown sheet is `422 validation` field `sheet`, "This file has no sheet named 'Budget'.".
- Cell mapping: numbers and integers `Number`; strings `Text`; booleans `Bool`; date-time cells `Date` (the date part; the time is dropped), on the 1900 and 1904 systems, with Excel's 1900 leap-year quirk handled (serial 59 is 1900-02-28, serial 61 is 1900-03-01; serial 60 is Excel's non-existent 1900-02-29 and is read as `Text("1900-02-29")`, so a date line item rejects the row with its normal "isn't a valid date" message); error cells (`#DIV/0!`) `Text` of the literal; empty `Empty`; a formula cell is its cached value (a formula with no cached value is `Empty`); merged cells read as the top-left value with the others blank (what calamine returns); strings have NUL replaced by U+FFFD; trailing blank rows and columns are trimmed; the header row is the first row.

**Steps**
1. Fixtures built with `rust_xlsxwriter` (`write_formula_with_result` for formulas, `merge_range`, `write_datetime`, `write_boolean`, number formats `0%`): formula cells read as their value (not the formula text); an uncached formula is `Empty`; a `0%`-formatted 0.25 is `Number(0.25)`; numbers stored as text stay `Text`; booleans; dates; error cells; merged region (top-left value, others blank); second sheet via `?sheet=`; a hidden sheet is not listed; empty rows in the middle are kept as `Empty` rows; trailing blanks trimmed; the sample shows dates as `yyyy-mm-dd`; two calls of `rows()` give the same rows.
2. Date systems: a serial of a 1900-system workbook (e.g. 45000 is 2023-03-15); serial 61 is 1900-03-01 and serial 59 is 1900-02-28; serial 60 is read as `Text("1900-02-29")`; a 1904-system workbook (a generated file whose `xl/workbook.xml` gets `date1904="1"`, rewritten with the `zip` crate) reads serial 0 as 1904-01-01.
3. Refusals: a `.xlsx` whose bytes are CSV text, a truncated zip, a zip with a corrupt sheet XML (no 500: `import.unreadable`), a zip whose entry inflates to 300 MB (a few hundred KB of deflated zeros) refused from the directory without inflating (assert it returns in under a second), more than 10,000 entries, a 20 MiB entry at ratio 2,000, a regular 1 MiB sheet XML at ratio 300 accepted, an `xl/sharedStrings.xml` entry whose directory size is `MAX_SHARED_STRINGS_BYTES` + 1 (a few hundred KB of deflated zeros) refused without inflating, and the guard function tested with explicit limits; `.xls`, `.xlsb` and `.xlsm` refused with the sentence; a sheet with `MAX_XLSX_CELLS` + 1 populated cells `import.too_large`.
4. Upload API: `sheets`, default sheet, `?sheet=` GET, unknown sheet `422`, CSV `?sheet=` still `422`; ownership as D1a2.
5. Memory (`tests/import_memory.rs`, same split): a small debug-mode XLSX (200,000 cells) by default; the full case is `#[ignore]` (release in CI): an XLSX at the cell cap generated with `rust_xlsxwriter` in constant-memory mode (about 5,000,000 numeric cells, under 50 MiB), measured through `open` (the counting pass), the sample and a full `rows()` pass; **and a second, text-heavy fixture**: about 1,000,000 distinct 20-character strings in one sheet, written so that the file has an `xl/sharedStrings.xml` (assert that the entry exists in the generated zip; constant-memory mode may write inline strings, in which case generate this fixture in normal mode), sized just under `MAX_SHARED_STRINGS_BYTES`, measured through the same three calls. Set `MAX_XLSX_CELLS` from the worse of the two measurements and `MAX_SHARED_STRINGS_BYTES` from the text-heavy one, so that the peak P of each fixture is within `R + 2P <= 310 MB`, and write the numbers in their doc comments.
6. Implement; `pnpm --dir web gen:api`; server gates.
7. Commit `feat(server): read XLSX uploads with typed cells`.

---

### Task D1d: Auto-match suggestions (server) (Sonnet)

**Wave 3. Depends on:** D1a2, D1c, A0. **Hub files:** `import/mod.rs`, `openapi.rs`, `web/src/lib/api/schema.d.ts`.

**Files:** create `crates/server/src/import/suggest.rs`, `crates/server/tests/import_suggest.rs`; modify `import/mod.rs` (route), `openapi.rs`, `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** `MappingDto`, `ImportDimDto` (D1c); `Sheet`, `uploads::find`, the `read` gate (D1a1, D1a2), S0's `ModelAccess<Planning>`; `Calendar::parse_label`.

**Interfaces — Produces:** `POST /api/v1/models/{id}/imports/uploads/{upload_id}/suggest` body `{target: {kind:"list", list_id}|{kind:"module", module_id}}` and optional `sheet` (string) → `SuggestionDto { mapping: MappingDto, unmatched: [string], column_group: {dim: ImportDimDto, headers: [string]}|null }`. Extractor `ModelAccess<Planning>` + `ApiPath<(Uuid, Uuid)>`, role Planner, `ProdLock::Ignore`, change-class in the sweep (a Planner-only POST); it takes a `read` permit from the import gate (`503 server.busy` when none is free in 10 s), not a query `Work` permit. `mapping` has `has_header` true, `decimal` from the upload's `decimal_hint`, `blank_cells` skip, `fixed` empty, the `sheet` asked for, and only the matched columns (sources are `{header}`). Matching compares `fold(s)` = lowercase with everything that is not a letter or digit removed: list target: Name = `name`, `fold(list)`, `fold(list)+"name"`; Code = `code`, `id`, `fold(list)+"code"`, `fold(list)+"id"`; Parent = `parent`, `fold(parent list)`; a property by `fold(line item name)`. Module target: a dimension by `fold(list or subset name)` (match name), `fold(list)+"code"`/`+"id"` (match code), Time by `time`, `period`, `month`, `date`, Versions by `version`, `scenario`; an input line item by `fold(name)`. A header matches the first target that claims it, in the order above; a target keeps its first header and a second header for it stays in `unmatched`. If at least 2 unmatched headers each read as a period label of the calendar (`Calendar::parse_label`) of the same level, they are returned as `column_group` (dim Time) and removed from `unmatched`. A `sheet` on a CSV upload is `422 validation` "This file has no sheets." (as for the upload `GET`). An unknown target is `422 structure.invalid`; a mapping that cannot be built (nothing matched) is still `200` with empty `columns`.

**Steps**
1. List target (`Country`, `Code`, `Region`, property headers, a numbered list's code column), module target (list names, `Time`, `Version`, line items with punctuation such as `Unit Price ($)`), two headers matching one target (second unmatched), case and spaces, a calculated line item never suggested, `decimal` follows the upload (`;` file gives `comma`), the wide-file `column_group` (`Jan 26`, `Feb 26`, `Mar 26` with an unrelated `Notes` left in `unmatched`), a `sheet` on a CSV upload (`422 validation`, "This file has no sheets."). This task runs before XLSX is readable (D1b is its parallel sibling), so no XLSX case is tested here; D2b step 4 runs an exported workbook through `suggest` with a `sheet`.
2. Roles and ownership: another user's upload `404`, another model's `404`, **a planner suggesting for their own upload works (two path parameters)**, viewer `403` before the body is read, outsider `404`; a held `read` gate gives `503`; the access sweep passes.
3. Implement; `pnpm --dir web gen:api` and commit `schema.d.ts`; server gates.
4. Commit `feat(server): suggest a column mapping from the file's headers`.

---

### Task R1b: Import preview endpoint (server) (Sonnet)

**Wave 3. Depends on:** R1a, D1a2. **Hub files:** `import/mod.rs`, `openapi.rs`, `web/src/lib/api/schema.d.ts`. About 500 lines with tests.

**Files:** create `crates/server/src/import/preview.rs`, `crates/server/tests/import_preview.rs`; modify `import/mod.rs` (route), `openapi.rs`, `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** R1a's `Plan`, `resolve_row`, `RowOutcome`, `engine_check_module` and the other types; `Sheet`, `uploads::find`, the `read` gate (D1a1, D1a2); S0's `ModelAccess<Planning>`; `MappingDto` (D1c).

**Interfaces — Produces:**
- `POST /api/v1/models/{id}/imports/preview` body `{upload_id: uuid, mapping: MappingDto}` → `PreviewDto { columns: [string], rows: [{row: integer, cells: [string], problems: [{column: string|null, message}]}], rows_total: integer, warnings: [string] }` for the first 100 data rows (cells as `display()` strings). Extractor `ModelAccess<Planning>`, `ProdLock::Ignore`, takes a `read` permit from the import gate (`503 server.busy` when none is free in 10 s), read-only (writes nothing). The structure is read from `handle.snapshot()`; the 100 rows go through `resolve_row` and, for a module plan, `engine_check_module` (a list plan's property cells are checked by the run, D2a1, and rejections then appear in its report). `warnings` include `{n} columns aren't mapped and are ignored: Territory, Qty.` and, when a typed XLSX number outside -1 to 1 meets a percent line item among the 100 rows, `Column 'Margin': {n} values are read as fractions (25 becomes 2,500%). Format the cells as percentages in Excel, or enter fractions.`

**Steps**
1. Preview API: first 100 rows only, `rows_total`, row numbers start at 2 with a header, problems per row with exact messages, `warnings` (ignored columns, the percent warning), a pre-switchover cell shown as a problem (module plan), planner allowed, viewer `403` and outsider `404`, another user's upload `404`, invalid mapping `422 import.mapping` with `errors[]`, a held `read` gate gives `503`, the preview never changes the model (change log unchanged), a planner previewing their own upload works; a list-target preview shows list-row problems (missing parent, ambiguous name) and a module-target preview shows engine problems.
2. Implement; `pnpm --dir web gen:api`; server gates.
3. Commit `feat(server): preview an import`.

---

### Task D2a1: Import run core: chunk planner, report, run repository (server) (Sonnet)

**Wave 3. Depends on:** R1a, A0, S0. **Hub files:** `import/mod.rs`; migration `0008`.

**Files:** create `crates/server/migrations/0008_import_runs.sql`, `crates/server/src/import/{apply.rs,report.rs,runs.rs}`, `crates/server/tests/{import_apply.rs,import_run.rs}`; modify `import/mod.rs`. No HTTP route in this task: the planner and the repository are tested directly (`Model::new` + `apply_batch` for the planner, `#[sqlx::test]` for the repository).

**Interfaces — Consumes:** R1a's `Plan`/`ModulePlan`, `ResolvedRow`, `Problem`, `RowOutcome`, `engine_check_module`, `duplicates`; engine commands (A0); `Model::generation`, `check_cells`, `canonical_coords`; `SourceCell`.

**Interfaces — Produces:**
- Migration (RLS on): `import_runs(id uuid PK, model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE, kind text NOT NULL DEFAULT 'import' CHECK (kind IN ('import','process')), parent_id uuid REFERENCES import_runs(id) ON DELETE CASCADE, position integer, action_id uuid, action_name text, user_id uuid REFERENCES users(id) ON DELETE SET NULL, file_name text NOT NULL, target jsonb NOT NULL, status text NOT NULL CHECK (status IN ('running','succeeded','partial','failed')), progress jsonb NOT NULL, report jsonb, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz)`; indexes `(model_id, created_at DESC)`, `(parent_id)`, `(user_id)`. `action_id` has **no foreign key** (actions live in the structure document); a deleted action leaves its id and name. `report` is null while `running`. A process run is a `kind = 'process'` row whose step runs are `kind = 'import'` rows pointing at it with `parent_id` and `position`.
- `runs.rs`: `start(db, new_run) -> Uuid` (inserts `running` with zero progress), `update_progress(db, id, &Progress)`, `finish(db, id, status, &RunReport)` (sets `finished_at`), `fail_interrupted(db) -> u64` (every `running` row becomes `failed` with `finished_at` and a report whose `failure` is `The server restarted while this import was running. Rows applied before that are kept.`, keeping its last progress counters), `get(db, model_id, run_id)`, `list(db, model_id, limit)` (top-level rows only, `parent_id IS NULL`, newest first), `steps_of(db, parent_id)`, and `prune(db, model_id)` (keeps the newest 500 top-level runs; step rows go with their process through the cascade).
- `report.rs`: `Progress { rows_total, rows_applied, rows_rejected, rows_blank, cells_applied, chunks_applied, chunks_total }` (a process row uses `{steps_total, steps_done}`), `RunReport { run_id, status, file_name, rows_total, rows_applied, rows_rejected, rows_blank, cells_applied, chunks_applied, chunks_total, failure: Option<String>, ignored_columns: [string], warnings: [string], rejected: [Rejected { row, column: Option<String>, reason, values: [string] }], rejected_shown, rejected_kept, rejected_truncated }` and `ReportBuilder` (accumulates counts and rejected rows). **Status rules:** `failed` = something was rejected or failed and nothing was applied; `partial` = something applied and (something rejected or a failure); `succeeded` = nothing rejected and no failure, including a file whose rows are all blank (then `rows_applied` is 0 and a warning says `No values to import: {n} rows were blank.`); `running` only in the row. **Bounded storage:** at most 10,000 rejected rows are kept; a reason is cut at 200 characters; values per kept row: 40 (each cut at 80 characters) for the first 1,000 rows, 10 for the next 4,000, none after (row, column and reason only), so the stored report stays under 8 MiB; `to_stored()` is the full kept list, `to_response()` the first 200 (`rejected_shown`).
- `apply.rs` (pure, no database, no actor): `pack_chunks(rows, plan, limits: ChunkLimits) -> Vec<Vec<..>>` where `ChunkLimits { cells: usize (100,000), list_items: usize (10,000) }`: rows are grouped until adding the next row would exceed the limit (a row is never split; a single row larger than the limit is its own chunk; a list chunk is bounded by items, a module chunk by cells, where a row's cells are its number of `(line item, coords, value)` entries). `prepare_chunk(model: &Model, plan: &Plan, rows: Vec<(usize, Vec<SourceCell>)>, superseded: &HashMap<usize, usize>) -> AppResult<PreparedChunk>`: resolves each row (`resolve_row`), rejects superseded rows, runs the engine check (`engine_check_module`; for a list plan the property cells are validated by `engine_check_list` on a scratch `model.clone()` after applying the chunk's `UpsertListItems`, and a failing row's item and cells are dropped), and returns the `Command`s (module: one `SetCells` per line item; list: `UpsertListItems` in file order, then `SetCells` for property cells), the applied and the rejected rows (with their source values for the report) and the model `generation` it was prepared against. `inside_actor(prepared, plan, rows) -> impl FnOnce(&Model) -> AppResult<(Vec<Command>, ChunkOutcome)>`: if `model.generation()` equals the prepared generation the prepared commands are used, otherwise the chunk is prepared again against that model (bounded by the chunk size); a chunk with nothing to write returns no commands.

**Steps**
1. Planner tests (`tests/import_apply.rs`, models built with `Model::new` and engine commands): chunk packing (exact boundaries at the limit, a row larger than the limit alone, a list chunk by items, a 10,000-item list chunk limit, empty input); module planning (one `SetCells` per line item, a row with one bad cell dropped from all its line items, duplicates, the engine's switchover message as the reason, blank rows); list planning (hierarchy and properties from rows, an idempotent second pass updates instead of duplicating, a row whose property fails drops its item and cells, items in file order, `engine_check_list` on a scratch clone leaves the real model untouched); `inside_actor` reuses the commands when the generation matches and re-prepares when a command was applied in between (the result differs accordingly); a chunk with nothing to write returns no commands.
2. Report tests: status rules (`failed`, `partial`, `succeeded`, all-blank `succeeded` with the warning), more than 10,000 rejected rows (`rejected_kept` 10,000, `rejected_truncated` true, 200 shown), the adaptive value trimming keeps the stored JSON under 8 MiB for 10,000 rows of 500 long values, reason and value cuts, NUL-free text.
3. Repository tests (`tests/import_run.rs`, `#[sqlx::test]`): `start` writes a `running` row with zero progress and a null report; `update_progress` and `finish`; `fail_interrupted` marks only `running` rows and keeps their progress; `list` returns top-level rows newest first and hides step rows; `prune` keeps the newest 500 top-level runs and deletes a pruned process's steps; deleting the model cascades; an unknown or other model's run id is `None`.
4. Implement; server gates.
5. Commit `feat(server): plan import chunks, build run reports and keep run history`.

---

### Task D4: Export menu on the module toolbar (web) (Sonnet)

**Wave 3. Depends on:** D3b, F1, M3 G4. **Hub files:** `web/src/lib/api/schema.d.ts`, the module toolbar (`web/src/features/grid/toolbar/grid-toolbar.tsx`, G4).

**Files:** create `web/src/features/grid/toolbar/export-menu.tsx` and `export-menu.test.tsx`; modify `web/src/features/grid/toolbar/grid-toolbar.tsx` (G4: the component takes `modelId`, `module` and `view: ViewDefinition`, which are all the menu needs; the menu is rendered next to the saved-views control and joins the entries that `use-toolbar-fit.ts` moves into the More menu when the row is too narrow), `web/src/features/grid/toolbar/grid-toolbar.test.tsx` if G4 created one, `web/src/lib/api/schema.d.ts`. Re-read the merged G4 files before editing; the names above are G4's.

**Interfaces — Consumes:** `POST /models/{id}/export` (D3a for `csv`, D3b for `xlsx`), `downloadFile`, `saveBlob`, `errorDetail` (F1), G4's `view` prop (the grid's current `ViewDefinition`: pivot, page selections, `show_summaries`, collapsed, hidden, filters, line items).

**Interfaces — Produces:** a toolbar `DropdownMenu` button `Export` (icon `Download`) with items `Export as CSV` and `Export as XLSX`, shown to every role that can see the grid (viewers included). It sends `{module_id, definition: <the grid's current ViewDefinition>, format}` and saves the returned file under the server's name. While a request is pending the trigger shows `Loader2` and is disabled; success toast `Export ready.`; `export.too_large` and other errors toast the server's detail (duration 8 s). The toolbar overflow rule of G4 (one row at 1280 px, More menu below) includes the new button.

**Steps**
1. Tests (msw): the request body equals the grid's current definition (change a page selector and a filter first); the file is saved with the `Content-Disposition` name; `422 export.too_large` toasts the sentence; pending disables the trigger; keyboard (Enter opens, arrows move, Escape closes); viewer sees the menu; the toolbar overflow keeps it reachable at a narrow width.
2. Implement; regenerate `schema.d.ts`; web gates.
3. Commit `feat(web): export the grid to CSV or XLSX from the toolbar`.

---

### Task P2a2: Text and image cards (web) (Sonnet)

**Wave 3. Depends on:** P2a1. **Hub files:** `page-view.tsx`, `package.json`/`pnpm-lock.yaml`.

**Files:** create `web/src/features/pages/cards/{text-card.tsx,image-card.tsx}` and tests; modify `page-view.tsx` (the card switch); dependencies `react-markdown ^10`, `rehype-sanitize ^6`.

**Interfaces — Consumes:** P2a1's card frame, card states and `UnavailableCard` switch.

**Interfaces — Produces:**
- **Text card:** `react-markdown` with `rehype-sanitize` (default schema), **no `rehype-raw`**; links open in a new tab with `rel="noopener noreferrer"` and only `http`, `https`, `mailto` schemes; markdown images render as links to their address (no image is loaded); typography with Tailwind classes (no typography plugin). Empty text shows `No text yet.`
- **Image card:** `<img>` with `alt`, `referrerPolicy="no-referrer"`, `loading="lazy"`, `className="size-full object-contain"`; a load failure shows `The image couldn't be loaded.`

**Steps**
1. Text card sanitizes `<script>`, `<img onerror>`, `javascript:` links and turns a markdown image into a link; headings, lists, code and tables render; the empty text state.
2. Image card attributes (`referrerpolicy`, `loading`, `alt`), the failure state, long alt text.
3. Both kinds inside the page view replace the fallback; the other kinds still render the fallback.
4. Implement; web gates.
5. Commit `feat(web): text and image cards`.

---

### Task P2b1: Chart card (web) (Sonnet)

**Wave 3. Depends on:** P2a1. **Hub files:** `page-view.tsx`, `package.json`/`pnpm-lock.yaml`, `components/ui/chart.tsx` (shadcn CLI).

**Files:** add the shadcn `chart` component (`pnpm --dir web dlx shadcn@latest add chart`); create `web/src/features/pages/cards/{chart-card.tsx,chart-data.ts,waterfall.ts,chart-table.tsx}`, `web/src/test/charts.ts` (a helper) and tests; modify `page-view.tsx` (the card switch).

**Interfaces — Consumes:** P2a1's `useCardQuery`, `applyContext`, the page gate, `card-frame`, card states; `formatValue` (`features/grid/core/format-value.ts`); `ViewResult` types (`features/grid/view-types.ts`).

**Interfaces — Produces:**
- **Window:** chart queries use a window of 200 rows x 100 columns; when `total_rows` or `total_columns` exceeds it the card footer says `Showing the first {n} of {total} rows.` / `…columns.`
- `chartData(result: ViewResult, { series: "rows" | "columns" }) -> { categories: string[]; series: { key: string; label: string; values: (number | null)[]; format: Format }[] }` (pure): rows or columns whose header has any member with `is_summary` are dropped (a total beside its parts would distort the chart); a label is the header's member labels joined with ` / `; `series: "rows"` makes each row a series with the columns as categories, `"columns"` the reverse; non-numeric and `na` cells are `null`; `format` is the format of the cell's line item (the `LineItems` header member, or the page member when line items are on the page). `chartSeriesColor(index)` = `var(--chart-${(index % 5) + 1})`; `axisTick(value)` = `Intl.NumberFormat("en", { notation: "compact" })`; `tooltipText(value, format)` = `formatValue(value, format)` (the functions the tooltip calls, exported so tests call them).
- **Chart card** (shadcn `ChartContainer` + Recharts; `role="img"` with `aria-label="{title} chart"` and a visually hidden data table, `chart-table.tsx`): `bar` (grouped, or stacked when `stacked`), `line`, `area` (stacked when `stacked`), `pie` (the first series only; slices are the categories; values that are not positive or are null are left out and the footer says `{n} values aren't shown.`), `combo` (bars for every series but the last, which is a line on a second, right-hand axis), `waterfall` (the first series; every category is a delta; a final `Total` bar; each bar floats from the running total before it; increases `var(--chart-2)`, decreases `var(--destructive)`, total `var(--chart-1)`; `waterfall.ts` computes `{label, start, end, kind: "increase"|"decrease"|"total"}[]`). Legend. Empty (`No data for this selection.`), loading, error + Retry, window footers.
- **Test technique (V10):** the data-shaping functions above carry the behaviour and are tested directly. Rendering tests live in files that install the stub from `web/src/test/charts.ts`, which gives `ResizeObserver` a fixed 600 x 300 size **in that test file only** (the global setup keeps its no-op) and mocks Recharts' `ResponsiveContainer` to that size; they assert the number of series and bars/lines in the SVG, the axes and the legend, and that the hidden data table equals the data. Tooltip text is asserted by calling `tooltipText`, not by hovering. Real rendering is checked in X1's screenshots.

**Steps**
1. Pure tests: `chartData` for rows-as-series and columns-as-series, summary dropping, `na` and text cells, multi-dimension labels, formats; `waterfall` running totals including negative first values and a zero; `chartSeriesColor` cycles after five; `axisTick`; `tooltipText` for percent, currency and plain numbers.
2. Rendering tests (with the stub): each of the six types renders the expected series count, stacked vs grouped, combo's last series on the right axis, pie leaves out non-positive values and shows the footer, waterfall colours by kind, legend, the sr-only table equals the data, window footers at 201 rows and 101 columns, empty, error + Retry, `503` on one card leaves the others, the card uses the page gate.
3. Implement; web gates.
4. Commit `feat(web): chart card`.

---

### Task P3a1: Page editor: layout, canvas, draft, save, guard, page menu (web) (Sonnet)

**Wave 3. Depends on:** P2a1. **Hub files:** `page-view.tsx`, `card-frame.tsx`, `package.json`/`pnpm-lock.yaml`.

**Files:** create `web/src/features/pages/editor/{layout.ts,layout.test.ts,editable-canvas.tsx,page-editor.tsx,use-page-draft.ts,page-menu.tsx}` and tests; modify `page-view.tsx` (the `Edit page` toggle and header actions) and `card-frame.tsx` (edit chrome: drag handle, delete); dependency `react-grid-layout ^2.3.0` (the 2.x line).

**Interfaces — Consumes:** P2a1 (`PageCanvas` props, `usePage`, card frames), `PATCH`/`DELETE /pages/{page_id}` (P1), `DiscardChangesDialog` (`features/modules`), TanStack Router's blocker.

**Interfaces — Produces:**
- **Pure layout module** (`layout.ts`, no React, no library): `type Layout = {x:number;y:number;w:number;h:number}`; `moveCard(layouts: Record<string, Layout>, id, dx, dy)` (x clamped to `0..12-w`, y to `>=0`, then `compact`), `resizeCard(layouts, id, dw, dh)` (w in `1..12-x`, h in `1..40`), `compact(layouts)` (vertical compaction in (y, x) order, overlaps pushed down), `stackOrder(layouts): string[]` (by y then x, the mobile order), `nextFreeY(layouts)`. All unit-tested.
- **Edit mode:** an `Edit page` button in the page header for `canEditPages(role)` sets `?edit=true`; `Save`, `Discard` and `Exit` in the header while editing. The canvas (`editable-canvas.tsx`) wraps `react-grid-layout` behind the same props as `PageCanvas` plus `onLayoutChange(layouts)`; 12 columns, `rowHeight` 80, 16 px margin, vertical compaction, drag only by the handle `.card-drag-handle` (a `GripVertical` icon button in the card header, so the grid inside a card never starts a drag), resize handle at the bottom-right; each card has a `Delete card` icon button; below 768 px editing is disabled with the note `Edit pages on a larger screen.` A page that arrives `pruned` starts the draft from the pruned definition and keeps the page notice.
- **Keyboard:** in edit mode each card is focusable (`tabIndex=0`, `role="group"`, `aria-label="Card: {title or kind}"`); arrow keys call `moveCard` by one cell, Shift+arrows `resizeCard` by one cell; an `aria-live="polite"` region announces `Moved to column {x+1}, row {y+1}.` / `Resized to {w} by {h}.`
- **Draft state** (`use-page-draft.ts`): name, context and cards (new cards get temporary keys `tmp-1`, `tmp-2`, never sent), `dirty` flag; **Save** sends `PATCH {definition, updated_at}` with cards that exist as `{id, …}` and new ones without `id`; success replaces the draft with the response, toast `Page saved.`; `409 page.conflict` opens an `AlertDialog` `Someone else changed this page` / `Reload the page to see their changes. Your edits can be copied from the cards before you reload.` with `Keep editing` and `Reload page`; other errors toast the detail and keep the draft. **Discard** (when dirty) opens `DiscardChangesDialog`. A TanStack blocker plus a `beforeunload` handler guard leaving with unsaved changes (the same dialog).
- **Page menu** (`page-menu.tsx`, `DropdownMenu` in the editing header): `Rename` (`Dialog`, field `Name`, `409 structure.name_taken` under it) and `Delete page` (`AlertDialog` `Delete {name}?`, `Its cards are deleted too. This can't be undone.`, confirm `Delete page`; navigates to `/m/$modelId/pages`).
- Viewers and planners see no edit entry points. Adding cards, editing a card and the page selectors arrive with P3a2.

**Steps**
1. `layout.test.ts`: `moveCard`/`resizeCard` clamps (left edge, right edge, `w` 12, `h` 40), compaction after a move up and a delete, overlap resolution order, `stackOrder`, `nextFreeY`.
2. Editor tests (jsdom cannot measure layout, so the library is exercised only through `onLayoutChange` called by the test): drag result via `onLayoutChange` updates the draft; delete card; keyboard move/resize and the live announcement; Save payload (existing ids kept, temporary keys not sent, `updated_at` sent), success toast; conflict dialog; Discard restores the saved definition; the unsaved-change guard blocks navigation and `beforeunload`; rename and delete page; a `pruned` page starts from the pruned definition; mobile (matchMedia) disables editing and keeps the stacked order; viewer and planner have no `Edit page`; pending states; skeleton and error states.
3. Implement; web gates.
4. Commit `feat(web): page editor canvas with drag, resize, keyboard and save`.

---

### Task T3: Developer page (web) (Haiku)

**Wave 3. Depends on:** T2, D1a2 (the limits route). Haiku: all copy and snippets are fixed below; the upload limit is read from the server (`GET /api/v1/imports/limits`) and never written into the web app (see `Good to know`). **Hub files:** `components/nav-user.tsx`, `routeTree.gen.ts`, `features/data/api.ts`.

**Files:** create `web/src/routes/_app/developers.tsx`, `web/src/features/developers/{developers-page.tsx,snippets.ts,developers-page.test.tsx}`; modify `web/src/components/nav-user.tsx` (menu item `Developers`, icon `Code2`, link to `/developers`, placed after `Profile`), `web/src/features/tokens/tokens-card.tsx` (a link `See examples` to `/developers`), `web/src/features/data/api.ts` (`useImportLimits`), `web/src/features/data/api.test.ts` (one case), `e2e/tests/shell.spec.ts` if it asserts the avatar menu items.

**Interfaces — Consumes:** `PageHeader`, `useDocumentTitle`, shadcn `Card`, `Button` and `Skeleton`, `sonner`, the tokens card (T2), `NavUser`, `queryKeys.importLimits` (F1) and `GET /api/v1/imports/limits` (D1a2, typed in `schema.d.ts`).

**Interfaces — Produces:** the page at `/developers` (under `_app`; `useDocumentTitle("Developers")`; `PageHeader` title `Developers`, description `Call OpenPlan from scripts with an API token.`). Cards (shadcn `Card`), each snippet in a `pre` (`font-mono text-sm bg-muted rounded-md p-3 overflow-x-auto`) with a `Button` (icon `Copy`, `aria-label="Copy command"`, toast `Copied.`; if the clipboard is unavailable, toast `Couldn't copy. Select the text and copy it.`):
- `API reference`: `Every endpoint, with its requests and responses, is documented in the interactive API reference.` Link-button `Open API reference` (`/api/docs`, new tab, icon `ExternalLink`).
- `Authenticate`: `Create a token in your profile, then send it as a bearer token. A token acts as you, with your role in every workspace, and needs no CSRF header.` Link `Create a token` (`/profile`). Snippet: `export OPENPLAN_URL="<origin>"` / `export OPENPLAN_TOKEN="op_pat_…"` / `curl -H "Authorization: Bearer $OPENPLAN_TOKEN" "$OPENPLAN_URL/api/v1/auth/me"` where `<origin>` is `window.location.origin`.
- `Export a view`: `curl -X POST "$OPENPLAN_URL/api/v1/models/$MODEL_ID/export" -H "Authorization: Bearer $OPENPLAN_TOKEN" -H "Content-Type: application/json" -d '{"module_id":"$MODULE_ID","definition":{"rows":[{"kind":"line_items"}],"columns":[{"kind":"time"}]},"format":"csv"}' -o view.csv`.
- `Write cells` (note: needs a token with Read and write access): `curl -X POST "$OPENPLAN_URL/api/v1/models/$MODEL_ID/cells" -H "Authorization: Bearer $OPENPLAN_TOKEN" -H "Content-Type: application/json" -d '{"edits":[{"line_item_id":"$LINE_ITEM_ID","coords":["$ITEM_ID","Jan 26"],"value":{"t":"number","v":1250}}]}'`.
- `Run a saved import` (note: needs a token with Read and write access and a Planner or higher role): `curl -X POST "$OPENPLAN_URL/api/v1/models/$MODEL_ID/actions/$ACTION_ID/run" -H "Authorization: Bearer $OPENPLAN_TOKEN" -F "file=@actuals.csv"`. Beneath it the sentence `A long import answers 202 with a run id. Poll it until its status is no longer running.` and the snippet `curl -H "Authorization: Bearer $OPENPLAN_TOKEN" "$OPENPLAN_URL/api/v1/models/$MODEL_ID/import-runs/$RUN_ID"`.
- `Good to know` (bullets): `A token with Read only access can read but not change anything.` / `Tokens can't create tokens, change passwords, or manage users, workspaces and workspace members.` / `Imports take CSV, TSV, TXT and XLSX files of up to {n} MB.` where `{n}` is `Math.round(max_upload_bytes / 1048576)` from `useImportLimits()` (`useQuery` with `queryKey: queryKeys.importLimits`, `queryFn: () => unwrap(api.GET("/imports/limits"))`, `staleTime: Infinity`). While it loads the bullet is a `Skeleton` line; if the request fails the bullet reads `Imports take CSV, TSV, TXT and XLSX files. The API tells you the limit when a file is too large.` The number appears nowhere in the web source.

**Steps**
1. `developers-page.test.tsx`: every card and snippet text above renders (with `window.location.origin` substituted), the links point to `/api/docs` (new tab, `noopener noreferrer`) and `/profile`, Copy writes the snippet to the clipboard and toasts, the failure toast when `writeText` rejects, the long-run snippet and its sentence, the upload-limit bullet for two different `max_upload_bytes` values served by msw (52,428,800 gives `50 MB`, 20,971,520 gives `20 MB`), its skeleton and its failure sentence, the avatar menu has `Developers`, the tokens card has `See examples`, axe has no violations.
2. Implement; web gates.
3. Commit `feat(web): developer page with API reference and token examples`.

---

### Task D2a2: Import run endpoint and lifecycle (server) (Sonnet)

**Wave 4. Depends on:** D2a1, D1a2, D1b (steps 3 and 6 run XLSX files), A0. **Hub files:** `app.rs`, `main.rs`, `import/mod.rs`, `openapi.rs`, `tests/access_sweep.rs`, `.github/workflows/ci.yml`, `web/src/lib/api/schema.d.ts`.

**Files:** create `crates/server/src/import/run_api.rs`, `crates/server/tests/{import_large.rs}`; modify `app.rs` (`AppState.import_chunks: ChunkLimits`, default 100,000 cells and 10,000 items; tests lower it), `main.rs` (call `import::runs::fail_interrupted` once after the migrations, before serving), `import/mod.rs` (routes), `tests/import_run.rs` (API cases), `openapi.rs`, `tests/access_sweep.rs` (append `/api/v1/models/{id}/import-runs/{run_id}` to `PLANNER_ONLY_GETS`), `.github/workflows/ci.yml` (in the `rust` job, after the engine timing step: `- run: cargo test --release -p openplan-server --test import_large -- --ignored`), `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** D2a1's planner, report and repository; R1a's `Plan`; D1a1's `Sheet`, D1a2's `uploads` and `ImportGate`; D1c's `check_mapping`, `problems_to_error`; A0's commands; S0's `ModelAccess<Planning>`; `handle_for`.

**Interfaces — Produces:**
- `pub(crate) async fn run_import(state: AppState, user_id: Uuid, handle: ModelHandle, started: StartedRun, file: RunFile, mapping: ImportMapping, label: RunLabel) -> RunHandle`, where `StartedRun { run_id: Uuid, permit: OwnedSemaphorePermit }` is the held `imports.run` permit and the id of the `running` row that `runs::start` wrote; `RunFile { file_name: String, kind: SheetKind, bytes: Bytes, upload_id: Option<Uuid> }` is a stored upload's bytes with its id (deleted after the run) or a file received with the request (`upload_id` is `None`); `RunLabel { action: Option<(ActionId, String)>, parent: Option<(Uuid, i32)> }` is the saved action's id and name and, for a process step, the process row and the step position; and `RunHandle { run_id: Uuid, join: JoinHandle<RunReport> }` has `async fn wait(self, within: Duration) -> RunWait` with `RunWait::Finished(Box<RunReport>)` or `RunWait::Running(Progress)` (waiting never cancels the task). The function **spawns a detached `tokio::spawn` task that owns the permit, the upload and the history row** and runs `execute_import` in it (inside a second `tokio::spawn` that the first awaits, so that a panic arrives as a `JoinError`). A dropped request leaves the task running to completion.
- `pub(crate) async fn execute_import(state: &AppState, user_id: Uuid, handle: &ModelHandle, run_id: Uuid, permit: &OwnedSemaphorePermit, file: RunFile, mapping: &ImportMapping, label: &RunLabel) -> RunReport` is the body of that task and does the work: pass 1 over the file (`Plan::new`, `duplicates`, row count), then chunk by chunk — rows resolved against `handle.snapshot()` outside the actor, `apply_with_answer(user_id, inside_actor(…))`, `runs::update_progress` after each chunk (retried once), `ReportBuilder` updated — then `runs::finish` (retried 3 times, 1 s apart; a persistent failure is logged and the report is still returned to a waiting request with a `warnings` entry `The run could not be saved to the import history.`), then it deletes the upload (kept when the run never started). If a chunk fails (`AppError`) the run stops: `failure` holds the sentence and the remaining rows are not applied. `permit` is only the proof that the caller holds `imports.run`; this function never releases it. D2b's process task calls `execute_import` once per step under the one permit it took for the whole process.
- A panic in `execute_import` (the `JoinError` of the inner task) finishes the row as `failed` with the failure `The import stopped unexpectedly.`
- `require_target_role(state, user, model_id, target: &ImportTarget) -> AppResult<()>` = `handle_for(…, Builder, ProdLock::Enforce)` for a list target and nothing more for a module target (the head extractor already checked Planner); D2b reuses it.
- `POST /models/{id}/imports/run` body `{upload_id, mapping: MappingDto, save_as?: string}`: extractor `ModelAccess<Planning>`; then, **before loading or parsing anything**, `require_target_role` and, when `save_as` is present, `handle_for(…, Builder, Enforce)`; the `save_as` name is validated and checked free (`409 structure.name_taken`) up front; then the `imports.run` permit (`503 server.busy` with `Retry-After` after 10 s, so a second run waits for the first); the upload is loaded with `uploads::find` (owner and model), the mapping goes through `check_mapping` with the file (`import.mapping` refuses before anything is written and keeps the upload); **when `save_as` is present the action is created now, with `CreateAction`, after `check_mapping` and before `runs::start`** (a name taken in the meantime is `409 structure.name_taken`; any failure fails the request with nothing applied), and its id and name go into `RunLabel.action`, so the history row carries them; `runs::start` writes the `running` row (if that fails the request fails `500` and nothing was applied); `run_import` is spawned; the handler waits up to 10 s for the task: finished gives `200` with the `RunReport` plus a top-level `action_id` (null without `save_as`), still running gives `202 {run_id, status: "running", progress, action_id}`. The action stays saved whatever the run's outcome (even `failed`) and whether or not the request is dropped; the stored report does not hold `action_id` (the history row does).
- `GET /models/{id}/import-runs/{run_id}` (extractor `ModelAccess<Planning>` + `ApiPath<(Uuid, Uuid)>`; Planner; in `PLANNER_ONLY_GETS`): `{id, kind, parent_id, position, action_id, action_name, user: {id, name}|null, file_name, target: {kind, id, name}, status, progress, report: RunReport|null (the first 200 rejected rows), created_at, finished_at}`; the client polls it every 2 s while `status` is `running`.
- Startup: `fail_interrupted` runs after migrations and before the listener is bound.

**Steps**
1. Review Focus 1 (small, default run): 2,000 rows into one line item with 3 bad rows and `import_chunks.cells` lowered to 500: the good rows are applied in chunks (`chunks_applied` is the expected number, each chunk one change-log batch: assert the batch count), the 3 rejected rows are in the report with row, column, reason and original values, status `partial`, the response is `200` and `GET import-runs/{id}` returns the same report.
2. Lifecycle (Review Focus 9): a run that takes longer than the wait (test hook lowers the wait to 50 ms and each chunk is slowed) answers `202`, polling `GET import-runs/{id}` shows `running` with growing `progress` and then `succeeded` with the report; **dropping the request future after the first chunk still finishes all chunks and finds the run `succeeded` in `import_runs`** and the upload deleted; a second run started while the first holds the permit waits then `503 server.busy` (hook lowers the wait), and runs again afterwards; a query (`POST /query`) and a single-cell `POST /cells` are not blocked by the run gate; `fail_interrupted` called at startup marks a leftover `running` row `failed` with the interrupted sentence; a panic in a chunk (test hook) finishes the row `failed`.
3. `tests/import_large.rs` (`#[ignore]`, run in release by CI): 100,000 rows x 1 line item with 3 bad rows (99,997 applied in 1 chunk, 3 rejected) and 300,000 rows x 1 line item (3 chunks, 3 batches); the time to finish is recorded and asserted with a bound taken from the measurement; the size of the change log after the 300,000-cell import (`pg_total_relation_size` of its table, per applied cell) is printed and written into the report so that Z1 can state the database cost of a 5,000,000-cell import in `docs/deploy.md`; while a 300,000-cell import runs, a single-cell `POST /cells` to the same model completes within 1 second (the actor is not stalled); a 100,000-item list import under a parent list with a properties module and a dependent module (10 chunks of 10,000 items) keeps the same bound; a 5,000,000-cell CSV, an XLSX at `MAX_XLSX_CELLS` and the text-heavy XLSX of D1b (shared strings at `MAX_SHARED_STRINGS_BYTES`) run within the peak R recorded here, and `R + 2P <= 310 MB` is asserted with P from D1a1/D1a2/D1b (lower the constants if not; report the final values).
4. List import: hierarchy and properties created from a file; an idempotent re-run updates instead of duplicating (item count unchanged, changed names and properties applied); items matched by code; a row with a bad property is rejected without its item; a numbered list; ambiguous names; a chunk that fails at the engine (delete the target list between chunks through a test hook) gives `partial` or `failed` with `failure` set and no 500.
5. Module import: across periods and versions; month label, quarter label with a quarterly line item, date cells; a `fixed` Versions member; pre-switchover cells rejected per row with the engine's message; blank skip leaves existing values and `clear` writes blanks; a wide months-across-columns file; an all-bad file is `failed` and writes no batch (change log unchanged); an all-blank file is `succeeded` with the warning; duplicates (later row wins, earlier reported).
6. XLSX end to end (D1b): a percent cell `0.25` into a percent line item gives 25%, the same value as CSV text `25%`; dates, a second sheet through the mapping's `sheet`, a formula cell's cached value.
7. Roles and locks: a planner running a list import `403` with **nothing applied** (change log and items unchanged) and the upload still there; a planner with `save_as` `403`; a planner module import `200`; production mode: list import `409` with nothing applied, module import `200`, `save_as` `409`; viewer `403` and outsider `404` before anything is loaded; `save_as` with a taken name `409` before anything is applied; `save_as` success returns `action_id` in the `200` and the action exists in the structure; **a `202` run with `save_as` returns `action_id` in the `202` body, the action exists before the run has finished and the history row carries its id and name; a dropped request still leaves the action and the finished run; an all-bad file with `save_as` is `failed` and the action is still saved;** another user's upload `404`; the upload is gone after a run and still there after a `422 import.mapping`; **a planner can run an import for their own upload (the route has one path parameter, `GET import-runs/{id}` two)**.
8. Report and text safety: NUL in a data cell, a header and the file name never cause a 500 and the run is saved; more than 10,000 rejected rows: `rejected_kept` 10,000, `rejected_truncated` true, 200 shown; a run history that cannot be started (drop the table inside the test database) is `500` with nothing applied; one that cannot be finished still returns the report with the warning.
9. Implement; add the CI step; `pnpm --dir web gen:api`; server gates, and the ignored tests with `cargo test --release -p openplan-server --test import_large -- --ignored`.
10. Commit `feat(server): run imports in a detached task with progress and history`.

---

### Task P2b2: KPI card (web) (Sonnet)

**Wave 4. Depends on:** P2b1. **Hub files:** `page-view.tsx`.

**Files:** create `web/src/features/pages/cards/{kpi-card.tsx,sparkline.tsx,kpi-data.ts}` and tests; modify `page-view.tsx` (the card switch).

**Interfaces — Consumes:** P2a1's `useCardQuery`, `applyContext`, page gate; P2b1's window footers, test stub and shadcn `chart`; `formatValue`.

**Interfaces — Produces:**
- **KPI card:** up to three small queries through the page gate, all with the context overrides on page dimensions only (window 200 x 100): the **value** (rows `[LineItems]`, no columns, pages = the card's `selections`, other page dimensions at their default member), the **comparison** (the same with the `comparison` member replacing that dimension's selection; only when `comparison` is set) and the **trend** (columns `[Time]`, `show_summaries: false`, window 120 columns; only when `sparkline_dim` is `"time"` and the module has Time). `kpi-data.ts` (pure) builds the three queries, the delta (absolute and percent: `+12.5%`, `-` when the comparison is 0) and its direction. The big value is formatted with `format_override ?? the line item's format` (`font-semibold text-4xl tabular-nums`); beneath it, when a comparison exists, the absolute delta and the percent delta with `ArrowUp`/`ArrowDown`/`Minus`; an increase is green (`text-emerald-600 dark:text-emerald-400`) and a decrease red (`text-destructive`), swapped when `inverted`; a zero delta is muted; the comparison's label (`vs Budget`) comes from its member label; a text or boolean line item shows its value without delta; the `Sparkline` is a Recharts `LineChart` without axes in `var(--chart-1)`, `aria-hidden`, with the visually hidden text `Trend over {n} periods`. Loading, empty (`No value for this selection.`), error + Retry.

**Steps**
1. Pure tests (`kpi-data.ts`): the three queries' bodies (pages from `selections`, the comparison replacing one dimension, the trend with `columns: [Time]` and `show_summaries: false`), context overrides apply to page dimensions only, delta and percent for up, down, zero and comparison 0, `inverted` flips the direction class, text and boolean values have no delta.
2. Card tests (msw; the sparkline's SVG under the P2b1 stub): format override, no comparison, no trend (module without Time), a selector on a dimension that is on the card's rows does nothing, query gate honoured (ten KPI cards never exceed 4 in flight), empty, error + Retry, `503` on one card leaves the others.
3. Implement; web gates.
4. Commit `feat(web): KPI card with comparison and trend`.

---

### Task P3a2: Page editor: add cards, grid/text/image config, page selectors (web) (Sonnet)

**Wave 4. Depends on:** P3a1, P2a2. **Hub files:** `card-palette.tsx`, `card-config-sheet.tsx`.

**Files:** create `web/src/features/pages/editor/{card-palette.tsx,card-config-sheet.tsx,context-config.tsx}`, `editor/configs/{common-fields.tsx,grid-config.tsx,text-config.tsx,image-config.tsx}` and tests; modify `page-editor.tsx` (Add card, Page selectors).

**Interfaces — Consumes:** P3a1's draft, canvas and `nextFreeY`; P2a2's text/image renderers (for the Markdown preview); `useStructure`; the module views hook (G4); `POST /members`.

**Interfaces — Produces:**
- **Palette:** an `Add card` button opens a `Sheet` (right) titled `Add a card` listing the kinds that have a config form: Grid (`Table2`) `A module's values as an editable table.`; Text (`Type`) `Notes and instructions in Markdown.`; Image (`Image`) `A picture from an https address.` Tasks P3b (Chart `ChartColumn` `Bars, lines, areas, pies, combos and waterfalls.`; KPI `Gauge` `One number with a change and a trend.`) and P2c (Action `MousePointerClick` `A button that runs an import action or process.`) add their entries. Choosing one adds the card at `nextFreeY` with default sizes (grid 12 x 6, chart 6 x 4, KPI 3 x 2, text 6 x 2, image 4 x 3, action 3 x 1) and opens its config sheet.
- **Card config `Sheet`** (right, `Form` per kind; react-hook-form + zod; Apply updates the draft): common `Title` (at most 80). Grid: `Module` `Select` (all modules), `View` `Select` (`Module default` or a saved view of the module). Text: `Markdown` `Textarea` with a `Write`/`Preview` `Tabs` (the preview uses the card's renderer) and a character counter against 20,000. Image: `Image address` (https only, at most 2,000) and `Alt text` (1-200). The sheet also tells when a page selector does not drive this card: `{Dimension} is on this card's rows, so the page selector does not drive it.` Changing the module clears the view.
- **Context config** (`Page selectors` `Popover` in the editing header): up to 6 rows, each a `Select` of the model's dimensions (every list, `Time`, `Versions`; one per dimension) and a default-member `Select` (members from `POST /members` of the first card using the dimension; `Card default` for none; stored as a member key), a remove button; add button `Add selector`; the sixth row disables it with `A page has at most 6 selectors.`; a selector no card uses shows `No card on this page uses this selector.`

**Steps**
1. Palette and config: add each offered kind with its defaults and the config sheet opening; config validation per form (https only, alt required, counter at 20,001); module change clears the view; the Apply updates the draft and Save sends the P1 shape for grid, text and image cards; the note for a selector on a card's rows.
2. Context config: add/remove/limit 6/defaults/unused note; the saved shape `{dim: {kind: "list", list: "<uuid>"}, default_key}`.
3. Editing an existing card prefills its form; a viewer and a planner see none of it; pending states; skeleton and error states of the editor's own queries (modules, views).
4. Implement; web gates.
5. Commit `feat(web): add cards and page selectors in the page editor`.

---

### Task D2b: Saved action runs, process runs, history (server) (Sonnet)

**Wave 5. Depends on:** D2a2, A1, D1b, D1d, D3b. **Hub files:** `app.rs`, `import/mod.rs`, `openapi.rs`, `tests/access_sweep.rs`, `web/src/lib/api/schema.d.ts`.

**Files:** create `crates/server/src/import/history.rs`, `crates/server/tests/{import_actions_run.rs,import_history.rs}`; modify `import/run_api.rs`, `import/mod.rs`, `openapi.rs`, `tests/access_sweep.rs` (append `/api/v1/models/{id}/import-runs` and `/api/v1/models/{id}/import-runs/{run_id}/errors.csv` to `PLANNER_ONLY_GETS`, and add an assertion that every template in `PLANNER_ONLY_GETS` and `auth::READS_BY_POST` is an operation of the OpenAPI document), `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** `run_import`, `execute_import`, `require_target_role`, `RunReport`, the repository (D2a1/D2a2); `ApiMultipart`, `ImportGate`, `Sheet`, `uploads` (D1a1, D1a2, D1b); `check_mapping(…, saved: true)`, `broken_reasons` (D1c); action and process accessors (A0, A1); `download::{attachment, csv_safe}` (D3a); `suggest` (D1d) for the round trip.

**Interfaces — Produces** (routes, extractors, roles and codes per the Endpoint table):
- `POST /models/{id}/actions/{action_id}/run` (multipart `file`, `DefaultBodyLimit` 51 MiB): extractor `ModelAccess<Planning>` + `ApiPath<(Uuid, Uuid)>`; loads the action from `handle.snapshot()` (`404` if unknown), refuses a broken action `422 import.mapping` (detail lists `broken_reasons`), `require_target_role` by the action's target (before the body is parsed); after the body is received it takes the `imports.run` permit, opens the file with the mapping's `sheet`, `check_mapping(…, saved: true)`, writes the `running` row with the action's id and name, spawns `run_import` and answers `200` or `202` exactly like `imports/run` (with `action_id` set to the action's id); the file is never stored.
- `POST /models/{id}/processes/{process_id}/run` body `{uploads: [{position: 1…n, upload_id}]}` (`ApiJson`, `DefaultBodyLimit` 64 KiB; one upload per step; no file travels in this request): before running anything it checks every step has an upload that exists for this caller and model (`422 validation`, field `uploads[<position>]`), `require_target_role` for **every** step (so one list step needs Builder and Enforce before step 1 runs), and **pre-flights every step** (file opens, action not broken, `check_mapping` with `saved: true`); any refusal is `422 import.mapping` with `errors[]` fields `steps[<position>]`, and nothing runs. It takes the `imports.run` permit once for the whole process and writes a `kind = 'process'` row (`running`, `progress {steps_total, steps_done}`), then one detached task, which owns that permit, runs the steps in order: for each step it writes an import run row with `parent_id` and `position` (`runs::start`) and calls `execute_import` (D2a2) with the permit it holds, so every step runs inside the single permit and none takes or releases one; `failed` stops the process (the rest are `skipped`, and their uploads are kept), `partial` continues; the uploads of executed steps are deleted. Response `200 {run_id, status, steps: [{position, action_id, action_name, skipped: bool, run_id: uuid|null, report: RunReport|null}]}` when it finishes within 10 s, else `202 {run_id, status: "running", progress}`; `status` is `failed` if any step failed, else `partial` if any was partial, else `succeeded`. `GET import-runs/{process run id}` returns the same steps (with their statuses and reports) while it runs.
- `GET /models/{id}/import-runs` (Planner) → top-level rows, newest first, 100: `[{id, kind, action_id, action_name, user: {id, name}|null, file_name, target: {kind, id, name}, status, rows_total, rows_applied, rows_rejected, cells_applied, rejected_truncated, created_at}]` (a process row lists `steps_total`/`steps_done` instead of the row counts). `GET …/import-runs/{run_id}/errors.csv` → `text/csv` attachment `import-errors-<first 8 characters of the run id>.csv` for an import row (a process row is `404`): UTF-8 BOM, `\r\n`, header `Row,Column,Reason,<the file's column headers>`, one line per kept rejected row with its stored values, every text through `csv_safe`, and, when truncated, a last line `# Showing the first {kept} of {rows_rejected} rejected rows.`. Row retention is D2a1's `prune`.

**Steps**
1. Saved action re-run (Review Focus 6): a second file with reordered columns maps correctly; a renamed header is `422 import.mapping` with the missing and unexpected lists, the model unchanged; extra unmapped columns are ignored and listed in `ignored_columns`; a broken action (deleted line item) is refused; an XLSX file read through the mapping's sheet name; a planner running a list-target action `403` with nothing applied, a module-target action `200`; production mode list-target `409`; viewer `403` and outsider `404` before the body is read; unknown action `404`; **a planner can run an action (two path parameters)**; a slow run answers `202` and the row is followed through `GET import-runs/{id}`.
2. Processes: order of execution; a `failed` step stops and the rest are `skipped` (their uploads kept, the executed ones deleted); a `partial` step continues; pre-flight refusal runs nothing (model and history unchanged) and names `steps[2]`; a list step needs Builder and a planner is refused before step 1 runs; a missing or foreign upload id is `422`; a body over 64 KiB `413`; the permit is held for the whole process (a second run or process waits, then `503`); each executed step has a history row with the action's name and `parent_id`; the process row ends with the status rule above; `202` for a slow process and `GET import-runs/{id}` shows steps finishing.
3. History: list newest first and limited to 100 top-level rows (step rows are not listed), `errors.csv` content (BOM, header row, original values in file order, truncation line, `Content-Disposition`), a cell `=SUM(A1)` in a rejected row is written `'=SUM(A1)` and a rejected `-5` stays `-5`, more than 10,000 rejected rows give 10,000 lines plus the truncation line, a process row's `errors.csv` is `404`, another model's run id `404`, planner allowed and viewer `403` on the GETs, the access sweep passes with the new `PLANNER_ONLY_GETS` entries and the existence assertion.
4. Export to import round trip (D3a, D3b, D1d): a module with number, percent, boolean, date, list-item, period and text line items is exported to CSV, uploaded, mapped through `suggest`, and run: every value equals the original; the same through XLSX, with the sheet name passed to `suggest` (its `sheet` field) and set as the mapping's `sheet`.
5. Implement; `pnpm --dir web gen:api`; server gates.
6. Commit `feat(server): saved action and process runs, import history and error reports`.

---

### Task I1a1: Import wizard: shell, upload, target, run and run report (web) (Sonnet)

**Wave 5. Depends on:** D2a2, D1a2, D1d, D2b (the `errors.csv` download of `RunReportView`; D2b precedes this task in the wave order and merges first), A1, F1. **Hub files:** `components/ui/progress.tsx` (shadcn CLI), `features/data/api.ts`, `schema.d.ts`.

**Files:** add the shadcn `progress` component; create `web/src/features/data/import/{import-wizard.tsx,wizard-state.ts}`, `import/steps/{upload-step.tsx,target-step.tsx,run-step.tsx}`, `web/src/features/data/run-report.tsx` and tests; extend `web/src/features/data/api.ts` (`useUploadImport`, `useUpload(modelId, uploadId, { sheet, hasHeader })`, `useDiscardUpload`, `useSuggest`, `useRunImport`, `useImportRun(modelId, runId)`, and the read hooks the three data screens and the page action card share: `useActions(modelId)`, `useAction(modelId, actionId)`, `useProcesses(modelId)`, `useProcess(modelId, processId)`); `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** `uploadFile`, `downloadFile`, `saveBlob`, `queryKeys.importUpload/importRuns` (F1); the upload, `GET upload`, delete upload, `suggest` and `imports/run` routes (D1a2, D1d, D2a2) and the read routes of actions and processes (A1); `GET import-runs/{run_id}` (D2a2); `canRunImports`, `canImportItems`, `canEditActions` (F1); `ProductionLock`; `useStructure`; `invalidateAfterImport` (S0/F1).

**Interfaces — Produces:**
- `ImportWizard` (`Dialog`, `max-w-4xl`) with props `{ modelId, open, onOpenChange, initialTarget?: {kind: "list" | "module", id: string} }`. Title `Import data`; a stepper (`ol`, current step `aria-current="step"`, done steps show `Check`) driven by a `STEPS` array; **this task registers three steps, `Upload`, `Target` and `Run`, and uses the auto-matched mapping from `suggest`** (task I1a2 inserts `Map columns` and `Preview` between Target and Run); focus moves to the step heading when the step changes; footer buttons `Back` and `Next`, `Run import` on the last step, `Done` after the result.
- **Upload:** a drop zone (`div role="button"`, `tabIndex=0`, Enter/Space opens the file chooser, drag-over highlight) with `Drop a CSV or XLSX file here, or choose a file.` and a `Choose file` button (`accept=".csv,.tsv,.txt,.xlsx"`); after the upload `{n} rows, {m} columns`, the file name, `Remove file` (deletes the upload), and for XLSX a `Sheet` `Select` (changing it fetches `GET …/uploads/{id}?sheet=` and clears the suggestion). Server refusals (`import.unreadable`, `import.too_large`, `413`, `import.upload_limit`, `503`) show their `detail` in a destructive `Alert`; spinner `Uploading…`. Cancelling or closing the wizard deletes the pending upload.
- **Target:** `RadioGroup` `Items of a list` / `Values of a module`, then a `Select`. `Items of a list` is disabled with `DisabledReason` for a planner (`Importing items needs the builder role.`) and in production mode (the production message). With `initialTarget` the step shows `Importing into {name}` and no choice.
- **Run:** entering the step calls `suggest` once per (upload, sheet, target) and shows `{n} columns will be imported.` and, when some are unmatched, `{n} columns aren't matched and will be ignored: {names}.`; for lists `Items that already exist are updated.`; for `canEditActions(role)` (and not production-locked) a `Checkbox` `Save as action` with a `Name` input (1-80; `409 structure.name_taken` under it) and, as soon as the answer (`200` or `202`) carries an `action_id`, the sentence `This action maps these columns by name: {headers}. A file with different column names needs a new mapping.`; planners do not see it. `Run import` posts `{upload_id, mapping, save_as?}`: a `200` shows the result; a `202` shows a determinate `Progress` (`rows_applied` of `rows_total`) with `Importing… {rows_applied} of {rows_total} rows.` while `useImportRun` polls every 2 s until the status is not `running`; every control is disabled and Escape/outside click are ignored while it runs; closing the dialog while a run goes on does not stop the run (the history screen shows it). An `import.mapping` refusal is a destructive `Alert` with the detail and the `errors` as a list.
- `RunReportView` (`run-report.tsx`, used by every result in the data screens): a status `Badge` (`Running`, `Succeeded`, `Partial`, `Failed`) and one sentence: succeeded `Imported {rows_applied} rows.` (with 0 applied: `No values to import.`); partial `Imported {rows_applied} of {rows_total} rows. {rows_rejected} rejected.`; failed `Nothing was imported. {rows_rejected} rows were rejected.` (the report's `failure` sentence is shown when set); a definition list (Rows in file, Imported, Rejected, Blank, Cells written, Chunks `{chunks_applied} of {chunks_total}`); `{n} columns weren't mapped and were ignored: {names}.` when `ignored_columns` is not empty; `warnings` as an `Alert`; a `Table` of the rejected rows (Row, Column, Reason, the first three values), at most the 200 in the response, with `Showing the first {rejected_shown} of {rows_rejected} rejected rows. The error report holds the first {rejected_kept}.` when they differ; `Download error report` (when `rows_rejected > 0` and `run_id` is set; `downloadFile` of `errors.csv`, saved under the server's name).
- After a run the wizard calls `invalidateAfterImport(queryClient, modelId, { structure: <list target> })`.

**Steps**
1. `wizard-state.ts` unit tests: payload building for list and module targets from a suggestion, defaults (`dot`, `skip`, `has_header`), clearing on sheet or target change.
2. Per-step tests (msw): upload accept/refuse/remove/sheet change, dropzone keyboard; target choice and disabled reasons; run step with the suggested mapping, unmatched columns, save-as visibility by role and mode, pending state (Progress, disabled, Escape ignored), the `202` path with polling until `succeeded`, `partial`, `failed` (fake timers, no wall clock), closing during a run, `import.mapping` errors, truncated rejected rows, download error report.
3. Read hooks: `useActions` and `useProcesses` return the lists with their `broken` reasons, `useAction` and `useProcess` one item, a `404` is an error state, and the keys are `queryKeys.actions` / `queryKeys.processes` (so a live `structure_changed` re-reads them).
4. `RunReportView` tests: each status sentence, the counts, ignored columns, warnings, the truncation sentences, the download (msw returns the CSV with a `Content-Disposition`), no download button without `run_id` or without rejections, `failure` shown, all-blank success.
5. Flows: full list import and full module import with the auto-matched mapping; XLSX with a sheet change; closing deletes the upload; `import.upload_limit` message; a11y test (axe) on each step.
6. Implement; regenerate `schema.d.ts`; web gates.
7. Commit `feat(web): import wizard with upload, target and run`.

---

### Task P3b: Page editor: chart and KPI config (web) (Sonnet)

**Wave 5. Depends on:** P2b2, P3a2. **Hub files:** `card-palette.tsx`, `card-config-sheet.tsx`.

**Files:** create `web/src/features/pages/editor/configs/{chart-config.tsx,kpi-config.tsx,member-select.tsx,format-override.tsx}` and tests; modify `card-palette.tsx` (adds the Chart and KPI entries) and `card-config-sheet.tsx`.

**Interfaces — Consumes:** P3a2's draft, sheet and common fields; `POST /members`; `useStructure`; the line-item format fields (`features/modules/line-item-format-fields.tsx`) for the override control.

**Interfaces — Produces:** two forms inside the card config sheet.
- **Chart:** `Module` `Select`; `View` `Select` (`Module default` or a saved view); `Chart type` `ToggleGroup` (single; items `Bar`, `Line`, `Area`, `Pie`, `Combo`, `Waterfall`, each with an icon and a `Tooltip`); `Series` `ToggleGroup` (`Rows` / `Columns`, help `Which side of the view becomes the lines or bars.`); `Stacked` `Switch` (enabled for bar and area only; otherwise disabled with `Only bar and area charts stack.`).
- **KPI:** `Module`; `Line item` `Select` (the module's line items); `Selections`: one row per dimension of the module (list or subset axes, `Time`, `Versions`; never line items) with a member `Select` (`Default` or a member from `POST /members`, searchable above 20 members); `Compare with` (optional): a dimension `Select` and a member `Select` (help `Shows the change against this member, for example Budget.`); `Number format` (optional override: `Line item format` by default, or decimals 0-6 and unit none/percent/currency with a three-letter code); `Show trend over time` `Switch` (only when the module has Time; sets `sparkline_dim: "time"`); `Invert colors` `Switch` (help `Use when a decrease is good, such as costs.`; sets `inverted`).
- Both forms save through the draft exactly in the P1 config shape; changing the module clears the dependent fields (view, line item, selections, comparison).

**Steps**
1. Chart form: all six types selectable by mouse and keyboard, series toggle, stacked switch disabled for pie/line/combo/waterfall with the reason, module change clears the view, the saved shape equals `{module_id, view_id|null, view|null, chart, series, stacked}`.
2. KPI form: dimension rows follow the module (a module without Time hides the trend switch), member options load from `/members` (searchable at 21), comparison needs both dimension and member, format override round trip, `inverted`, line item list follows the module, saved shape equals `{module_id, line_item_id, selections[], comparison, format_override, sparkline_dim, inverted}`.
3. Palette: Chart and KPI entries now appear and add cards with the default sizes (6 x 4 and 3 x 2) and open their form; editing an existing chart or KPI card prefills.
4. Implement; web gates.
5. Commit `feat(web): chart and KPI configuration in the page editor`.

---

### Task I1b1: Actions and import history screens (web) (Sonnet)

**Wave 6. Depends on:** I1a1, D2b, A1, F1. **Hub files:** `routeTree.gen.ts`, `features/data/api.ts`, `schema.d.ts`.

**Files:** create routes `web/src/routes/_app/m/$modelId/data/{actions.tsx,history.tsx}`; `web/src/features/data/{actions-page.tsx,run-action-dialog.tsx,import-history.tsx,run-details-sheet.tsx,target-label.ts}` and tests; extend `web/src/features/data/api.ts` (`useDeleteAction`, `useImportRuns`, `useRunAction`); `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** A1's routes, D2a2/D2b's run, saved-action run and history routes, `RunReportView`, `useImportRun` and the wizard hooks (I1a1), `uploadFile`, `downloadFile`, `saveBlob`, `canRunImports`, `canEditActions`, `relativeTime`, `useStructure`, `ProductionLock`/`DisabledReason`.

**Interfaces — Produces:**
- **Actions page** (`/m/$modelId/data/actions`; `PageHeader` `Actions`, description `Saved imports you can run again.`): `Table` of Name; Target (`Items of {list}` or `Module {module}`; a missing target shows `Missing`); Columns (mapped, not counting ignored; a `Tooltip` lists the headers, and for a file with values across columns says `This action maps these columns by name, so next year's file needs a new mapping.`); Status (`Ready` secondary `Badge`, or destructive `Needs attention` with a `Tooltip` listing `broken`); Last run (`relativeTime` and a status badge from the newest matching top-level run in `useImportRuns`, else `Never`); `Run` button for `canRunImports(role)` (disabled with `DisabledReason` for a broken action `Fix the mapping before running this action.`, a list-target action for a planner `Importing items needs the builder role.`, a list-target action in production mode the production message); a kebab for `canEditActions(role)` with `Delete` (`AlertDialog`: `Delete {name}?`, `Processes that use it must be changed first. This can't be undone.`, confirm `Delete action`; `409 structure.in_use` toasts the server detail). Empty state: icon `FileInput`, `No saved imports yet. Import a file and save its mapping to run it again.` (its primary action, `New import`, and the kebab's `Edit mapping` are added by I1a2 because they open the wizard). Skeleton and `ErrorState` with Retry.
- **Run action dialog:** title `Run {name}`; `Choose a file with the same columns as the first one you imported.`; a file input (`.csv,.tsv,.txt,.xlsx`); `Run import` (spinner; Escape and outside click ignored while pending); a `202` is followed with `useImportRun` as in the wizard; then `RunReportView` and `Done`. A `422 import.mapping` shows a destructive `Alert` with the detail and the `errors` as a list (the missing and unexpected columns) and keeps the dialog open for another file.
- **History page** (`/m/$modelId/data/history`; `Import history`, `Every import run in this model, newest first.`): for `canRunImports(role)`; a viewer sees an `EmptyState` (icon `Lock`, `Import history is for planners and builders.`). `Table`: When (`relativeTime`), Who (name or `Unknown`), Import (action name, `Manual import` or `Process`), Target, File, Status badge (`Running` rows refresh every 2 s), Rows (`{applied} of {total}`, or `{steps_done} of {steps_total} steps` for a process), Rejected (count), a `Report` download button when rejected > 0. A row opens `RunDetailsSheet` (`GET /import-runs/{run_id}`, `RunReportView`; for a process row the list of its steps with their statuses, each opening its own run). The note `Showing the 100 most recent runs.` appears at 100 rows. Empty: icon `History`, `No imports yet. Runs appear here after you import a file.`

**Steps**
1. Actions page: columns and last-run join, ready vs needs-attention tooltip, wide-file tooltip, run enablement matrix (viewer: no Run button; planner with module action ok; planner with list action disabled with the reason; production mode list action disabled; broken action disabled), run dialog success, the `202` path and `import.mapping` error with the missing/unexpected list (the dialog stays open), pending disables everything, delete flow incl. `409 structure.in_use`, builder-only kebab, skeleton, empty (no action yet), error + Retry.
2. History page: rows and badges, `Unknown` user, `Manual import`, a process row with its steps, running rows refresh, download button, details sheet (`useImportRun`), 100-row note, viewer's no-access state, skeleton, empty, error + Retry.
3. Implement; regenerate `schema.d.ts` and the route tree; web gates.
4. Commit `feat(web): actions and import history screens`.

---

### Task I1b2: Processes screen (web) (Sonnet)

**Wave 6. Depends on:** I1a1, D2b, A1. **Hub files:** `routeTree.gen.ts`, `features/data/api.ts`, `schema.d.ts`.

**Files:** create route `web/src/routes/_app/m/$modelId/data/processes.tsx`; `web/src/features/data/{processes-page.tsx,process-sheet.tsx,run-process-dialog.tsx}` and tests; extend `web/src/features/data/api.ts` (`useSaveProcess`, `useDeleteProcess`, `useRunProcess`; the read hooks `useProcesses` and `useProcess` already exist from I1a1); `web/src/lib/api/schema.d.ts`.

**Interfaces — Consumes:** A1's process routes, D2b's process run, `RunReportView`, `useImportRun`, the upload hooks and the read hooks `useActions`, `useProcesses`, `useProcess` (I1a1), `uploadFile`, `canRunImports`, `canEditActions` (F1).

**Interfaces — Produces:**
- **Processes page** (`/m/$modelId/data/processes`; `Processes`, `Imports that run one after another.`): `Table` of Name; Steps (`{n} steps`, action names joined ` → ` truncated with a title); Status (`Ready` / `Needs attention` from `broken`); `Run` (disabled with the same reasons as actions, for any list-target step); kebab `Edit` / `Delete` and a `New process` button for `canEditActions(role)`. Edit `Sheet` (`New process` / `Edit process`): `Name`; an ordered list of steps, each a `Select` of actions with `Move step {n} up` / `Move step {n} down` / `Remove step {n}` icon buttons (keyboard reachable), `Add step` (disabled at 10: `A process has at most 10 steps.`); `Save process` (spinner; `409 structure.name_taken` under Name; `422 structure.invalid` as an `Alert`). Empty state: icon `ListOrdered`, `No processes yet. A process runs several saved imports in order.`, primary action `New process` for builders. Skeleton and `ErrorState`.
- **Run process dialog:** one file input per step labelled `Step {n}: {action name}`; `Run process` first **uploads each file** through `POST /imports/uploads` (sequentially: `Uploading step {n} of {m}…`; if an upload or the dialog's cancel happens before the run starts, the uploads already made are deleted), then posts `{uploads: [{position, upload_id}]}`; a `202` is followed with `useImportRun` (the process row lists its steps while they run); the result shows each step's `RunReportView` or `Skipped` and a process status badge; a pre-flight `422 import.mapping` lists the `steps[n]` problems and keeps the uploads so another attempt can reuse them; Escape and outside click are ignored while uploading or running.

**Steps**
1. Page: list and status, create/edit sheet (add, remove, reorder with the buttons and keyboard, the 10-step limit, validation errors), delete, role matrix, run enablement (viewer none; planner with a list step disabled with the reason), skeleton, empty (with and without the action by role), error + Retry.
2. Run dialog: N file inputs, sequential uploads and the body (`uploads` by position), cleanup of uploads on cancel and on a failed upload, the `202` path with step progress, per-step results including `Skipped`, pre-flight refusal rendering, pending states.
3. Implement; regenerate `schema.d.ts` and the route tree; web gates.
4. Commit `feat(web): processes screen`.

---

### Task I1a2: Import wizard: map columns, preview, edit mapping, entry points (web) (Sonnet)

**Wave 7. Depends on:** I1a1, I1b1 (it modifies the Actions page that I1b1 creates), R1b, L2, M3 G4. **Hub files:** Lists toolbar, module toolbar, `actions-page.tsx`.

**Files:** create `web/src/features/data/import/{column-group.tsx,required-mapping.ts}`, `import/steps/{map-step.tsx,preview-step.tsx}` and tests; modify `import-wizard.tsx` and `wizard-state.ts` (two steps inserted; edit-action mode), `run-step.tsx` (uses the edited mapping), `web/src/features/lists/` (toolbar `Import` button), `web/src/features/grid/toolbar/` (module `Import` button), `web/src/features/data/actions-page.tsx` (`New import`, the empty-state action, `Edit mapping`).

**Interfaces — Consumes:** I1a1's wizard, hooks and `RunReportView`; the `preview` route (R1b) and `GET upload` with `has_header` (D1a2); `canRunImports`, `canImportItems`, `canEditActions`; `ProductionLock`; `useStructure`.

**Interfaces — Produces:**
- **Map columns** (inserted after Target; the stepper becomes `Upload`, `Target`, `Map columns`, `Preview`, `Run`): one row per file column (header, first sample value in muted text) with a `Select` `Map to`: for a list target `Name`, `Code`, `Parent ({parent list})`, each property line item, `Don't import`; for a module target `{Dimension} (by name)`, `{Dimension} (by code)` for lists, each input line item, `Don't import`. The step starts from the `suggest` result and the user edits it. Options: `File has a header row` `Switch` (off refetches the upload with `has_header=false`: `Column N` labels and the first row as data, and switches the sources to column numbers), `Number format` `Select` (`1,234.56` = dot, `1.234,56` = comma; default from `decimal_hint`), `Blank cells clear values` `Switch` (off; help `Off: blank cells leave existing values unchanged.`). For a module target: **`Fixed values`**, one `Select` per dimension of the module that no column is mapped to (`Version: Budget`; help `Use this when the file has no column for it.`), stored in `mapping.fixed`; and `Values are spread across columns (for example one column per month)` `Switch`: `Dimension` `Select` (the module's dimensions), `Line item` `Select`, and checkboxes `Columns holding values` (preselected from `suggest.column_group`; those columns become `member_values`). `required-mapping.ts` mirrors the server's messages S2-S4 and S8-S11 to show live `Alert` warnings (`Map a column to Time, or fix its value: Units has it as a dimension.`); the server stays the authority: `Next` calls `preview`, and `import.mapping` errors are attached to the columns named in `errors[].field` and shown in the step.
- **Preview:** `Table` of the first 100 rows (a leading Row column; cells with problems get `bg-destructive/10` and a `Tooltip` with the message, plus visually hidden text for screen readers); `{n} of the first 100 rows have problems.`; `warnings` as an `Alert`; `{rows_total} rows in the file.`
- **Run** keeps I1a1's behaviour with the edited mapping; the save-as sentence lists the mapped headers (and, for a column group, says `The month columns are matched by name; next year's file needs a new mapping.`).
- **Edit mapping** (`action` prop on `ImportWizard`: `{id, name, mapping}`): steps `Upload` (`Choose a sample file to check the mapping against.`), `Map columns` (prefilled by header; a mapped header missing from the sample shows as `Missing from the file: {header}` with `Remove`), `Preview`, then `Save action` (PATCH; no Run). The target is fixed.
- **Entry points:** Lists screen toolbar `Import` (rendered for builders, admins and planners; disabled with the reasons above for planners and in production mode; not rendered for viewers) opens the wizard with the list as the target; module toolbar `Import` (planners and above) with the module; Actions page `New import` (planners and above; builders for list targets) and `Edit mapping` in the kebab for builders.

**Steps**
1. `wizard-state.ts` additions: header vs index sources, the column group to `member_values`, `fixed`, defaults, clearing on sheet, target or header-row change.
2. Map step: auto-match from `suggest`, live warnings (the S-rule messages), options, the header-row switch refetch, fixed values, the wide-file UI building `member_values`, server `import.mapping` errors on columns; preview step: problem highlighting with tooltip and sr text, warnings, the 100-row table.
3. Flows: full list import and full module import with edits; XLSX with a percent warning; edit-mapping mode (prefill by header, missing header row, save); entry points (Lists, module toolbar, Actions page) with role gating and the disabled reasons; the empty state of the Actions page now has its action.
4. a11y test (axe) on the new steps; screenshots are taken by X1.
5. Implement; web gates.
6. Commit `feat(web): import wizard mapping, preview, edit mapping and entry points`.

---

### Task P2c: Page action card (web) (Sonnet)

**Wave 7. Depends on:** P2a1, P3a2, I1b1, I1b2, A1. **Hub files:** `page-view.tsx`, `card-palette.tsx`, `card-config-sheet.tsx`.

**Files:** create `web/src/features/pages/cards/action-card.tsx`, `web/src/features/pages/editor/configs/action-config.tsx` and tests; modify `page-view.tsx` (the card switch; **delete `cards/unavailable-card.tsx`**, now unused), `card-palette.tsx` (adds the Action entry), `card-config-sheet.tsx`.

**Interfaces — Consumes:** `useAction`, `useProcess`, `useActions`, `useProcesses`, `RunActionDialog`, `RunProcessDialog`, `RunReportView` (I1a1, I1b1, I1b2); `uploadFile`; `canRunImports`; `ProductionLock`; sonner.

**Interfaces — Produces:**
- **Action card:** a `Button` (label from the config). Disabled with `DisabledReason` for a viewer (`Viewers can't run actions.`), a broken action or process (the sentence), a list-target action for a planner (`Importing items needs the builder role.`) or in production mode (the production message). Click: if `confirm`, an `AlertDialog` (`Run {label}?`, `This changes data in the model.`, `Run`, `Cancel`); then the run dialog of the target (`RunActionDialog`, or `RunProcessDialog` for a process); when the run finishes (or is still `running` after the dialog is closed) a toast: `Imported {rows_applied} of {rows_total} rows.` plus, when rows were rejected, ` {rows_rejected} rejected.`, with an action `View history` (planners and above; navigates to `/m/$modelId/data/history`); for a process `Ran {executed} of {total} steps.` (error variant when its status is `failed`); status `failed` is an error toast with the report's `failure` or first rejection reason; a refusal toasts the server's detail. Invalidates `queryKeys.importRuns` and the model's queries.
- **Action config form** (in the card config sheet): `Run` `Select` grouped `Actions` / `Processes`, `Button label` (1-40), `Switch` `Ask before running` (default on). The palette's Action entry (`MousePointerClick`, `A button that runs an import action or process.`, default size 3 x 1) is added.
- `unavailable-card.tsx` is removed: every card kind now has a renderer.

**Steps**
1. Card: confirm, run dialog for an action and for a process, toast text and the `View history` link, the disabled reasons for viewer, broken, planner with a list-target action, production mode, pending state, `202` handling, per-card skeleton, error + Retry.
2. Config form: group select, label length, confirm switch, the saved shape `{target: {kind, action_id|process_id}, label, confirm}`, editing prefills; the palette adds the card.
3. `page-view.tsx` renders every kind; no import of `unavailable-card.tsx` remains.
4. Implement; web gates.
5. Commit `feat(web): page action card that runs imports and processes`.

---

### Task N1: Build/Use mode and navigation (web) (Sonnet)

**Wave 7. Depends on:** P2a1, I1b1, I1b2 (it links to the routes they create; the pages list and `NewPageDialog` come from P2a1, `useActions` from I1a1 through I1b1). **Hub files:** `features/build/build-nav.ts`, `components/app-sidebar.tsx`, `components/site-header.tsx`, `features/build/model-commands.tsx`, `routes/_app/m/$modelId/index.tsx`.

**Files:** create `web/src/features/build/{mode.ts,mode-tabs.tsx,use-sidebar.tsx}` and tests; modify `build-nav.ts`, `build-sidebar.tsx`, `model-commands.tsx`, `model-layout.tsx` (records the mode), `web/src/components/{app-sidebar.tsx,site-header.tsx}`, `web/src/routes/_app/m/$modelId/index.tsx`, the existing tests of those files, and any `e2e/tests/*.spec.ts` that asserts the sidebar or header.

**Interfaces — Consumes:** `pagesQuery`, `usePages`, `usePage` and `NewPageDialog` (P2a1), the data routes `/m/$modelId/data/{actions,processes,history}` (I1b1, I1b2), `useActions` (I1a1), `canRunImports`, `canEditPages` (F1), `useModelNotFound`, `useCurrentWorkspace`, the router context (`context.me`, the query client).

**Interfaces — Produces:**
- `mode.ts` (pure, tested): `modeOfRoute(routeId: string): "build" | "use"` is `use` for every route id under `/_app/m/$modelId/pages` and `build` otherwise; `readLastMode(modelId)` / `writeLastMode(modelId, mode)` on `localStorage["openplan.mode.<modelId>"]`, every access in try/catch (a throwing or invalid store reads as none); `landingFor({ role, pageIds, lastMode }): { to: "build" } | { to: "use"; pageId }`: a stored `use` with at least one page lands on the first page; a stored `build` lands on Build; with nothing stored a viewer or planner lands on the first page when the model has pages, anyone else on Build; no pages always Build.
- **URL-driven mode:** the mode is `modeOfRoute` of the current route, never state. `ModelLayout` writes the mode to storage on every route change. `/m/$modelId` (`routes/_app/m/$modelId/index.tsx`) `beforeLoad` loads the model and its page summaries through `context.queryClient.ensureQueryData`, finds the role from `context.me`, and redirects to `/m/$modelId/modules` (Build) or `/m/$modelId/pages/$pageId` (Use); any failure falls back to `/m/$modelId/modules`.
- **Header:** inside a model `SiteHeader` shows a `Tabs` (`Build` | `Use`) after the breadcrumb; selecting `Build` goes to `/m/$modelId/modules`, `Use` to the first page (`/m/$modelId/pages/$firstPageId`) or to `/m/$modelId/pages` when there are none. Breadcrumb gets crumbs for `Pages`, the page name, `Actions`, `Processes` and `Import history`.
- **Sidebars:** `app-sidebar.tsx` renders the Use sidebar on a Use route and the Build sidebar otherwise. `UseSidebar` has a `Pages` group listing each page in order (links, active state, `LayoutDashboard` icon), `New page` as a group action for `canEditPages(role)` (opens P2a1's `NewPageDialog`), skeleton items while loading, an `ErrorState` with Retry, `No pages yet.` when empty. `BUILD_GROUPS` gains **Data** (`Actions` `/m/$modelId/data/actions`, `Processes` `/m/$modelId/data/processes`, `Import history` `/m/$modelId/data/history`, the last only when `canRunImports(role)`) and **Apps** (`Pages`, a link into Use mode: `/m/$modelId/pages`), between `Structure` and `Model`; `BuildPath` gains the four paths; `visibleGroups(role)` filters by role for the sidebar and the palette.
- **Command palette:** `Pages` and `Actions` groups appear once the search has at least 2 characters (as line items do): a page opens `/m/$modelId/pages/$pageId`, an action opens `/m/$modelId/data/actions`; skeleton, error and the model-not-found guard as the existing groups; `Go to …` entries for the new screens in the `Model` group.

**Steps**
1. `mode.test.ts`: `modeOfRoute` for page, pages list, module, lists, data and settings route ids; storage read/write with a throwing store and an invalid value; the full landing matrix (role x has pages x stored mode x nothing stored).
2. Sidebar and header tests: Build shows Structure, Data, Apps, Model; Use shows Pages; the Data group per role (`Import history` hidden for a viewer); `Apps > Pages` goes to the pages list and the sidebar becomes the Use sidebar; the tabs reflect the route and navigate; a deep link to a module renders the Build sidebar and a deep link to a page the Use sidebar; `New page` for builders only; states of the Use sidebar; `useModelNotFound` renders nothing; breadcrumbs for the new routes.
3. Redirect tests (`renderApp("/m/<id>")`): the matrix above through the real route tree, failure fallback, a model the user cannot see.
4. Palette tests: pages and actions appear after 2 characters and navigate; skeleton and error; the new `Go to` entries respect role.
5. Update the affected e2e specs' assertions (sidebar groups, header); web gates; a11y test on the tabs and the Use sidebar.
6. Implement; regenerate the route tree.
7. Commit `feat(web): build and use modes with URL-driven navigation`.

---

### Task X1: End-to-end suite (Sonnet)

**Wave 8. Depends on:** all other tasks. **Hub files:** `e2e/tests/helpers.ts`.

**Files:** create `e2e/tests/{pages.spec.ts,import-export.spec.ts,tokens.spec.ts,mode.spec.ts}`; modify `e2e/tests/helpers.ts` (adds `createPageViaApi`, `createActionViaApi`, `createProcessViaApi`, `createViewViaApi`, `createCountriesFixture`, `createRevenueFixture` seeding through the existing `*ViaApi` helpers and S0's `uploadViaApi`) and `e2e/tests/xlsx.ts` if a helper is missing. Run with `E2E_PORT=8098`, after `pnpm --dir web build` and `cargo build -p openplan-server`.

**Interfaces — Consumes:** everything; S0's `withApi`, `uploadViaApi`, `downloadViaApi`, `readXlsx`, `readCsv`; `screenshot(page, name, { ready, reopen })`.

**Interfaces — Produces:** the four specs, the helpers listed under Files, and the light/dark screenshots in `e2e/screenshots/` (gitignored, uploaded by CI).

**Steps** (each spec starts with `login(page, ADMIN)` or signs in as the user it names; seed with the API helpers, drive the UI for what is under test)
1. `pages.spec.ts`: a builder creates the page `Executive Overview` (New page), clicks `Edit page`, adds the selector `Regions` (`Page selectors`), a Grid card (module Revenue, Regions on its pages), a Line chart card and a KPI card (`Units` against Budget), a Text card and an Action card, saves; a planner opens it in Use mode, changes the region in the context bar, the grid values and the KPI change and the URL holds `ctx.<listId>`; reload keeps the region; a card whose module has no Regions does not change; edit mode: a real mouse drag of a card by its handle and a keyboard move/resize persist after Save and reload; a viewer has no `Edit page` and the action button is disabled with its reason; **delete the module through the API and reload: the page loads, the card is gone and a builder sees the `pruned` notice (a viewer does not); saving the page clears the notice**; the unsaved-change guard appears when leaving a dirty editor; a conflict (change the page through the API between load and save) shows the conflict dialog.
2. `import-export.spec.ts`: (a) import a CSV of countries into the list Countries with parents through the wizard (Lists screen `Import`; steps Upload, Target, Map columns, Preview, Run); (b) import a CSV of Units into the module Revenue with one bad row: the preview highlights the cell, the summary says 1 rejected, `Download error report` yields a CSV (read with `readCsv`) holding exactly that row with its original values; (c) `Save as action` (the wizard shows that the action maps these columns by name), then run the action from the Actions page with a second file whose **columns are reordered**: the values land in the right place; a file with a **renamed header** is refused with the missing/unexpected message and the dialog stays open; (d) a wide file (months across columns, `Values are spread across columns`), a file with no Versions column imported with the **fixed value** `Version: Budget`, and an XLSX file with a percent cell (the preview warns, the value lands as 25%); (e) a planner sees the list `Import` disabled with its reason and no `Save as action`, and can run a module-target action; (f) export the grid from the module toolbar to CSV and XLSX; parse both (`readCsv`, `readXlsx`) and compare with the grid's text; re-import the CSV through the wizard and the grid is unchanged; (g) import history lists the runs, the details sheet shows the rejected row, a viewer sees the no-access state; (h) a process of two actions: the UI uploads one file per step and runs them, the second step is skipped when the first fails and its upload is kept; (i) a CSV of 200,000 rows is uploaded through `uploadViaApi` and run through `POST /imports/run`: the response is `200` or `202`; on `202` the run is polled through `GET /import-runs/{id}` (up to 120 s) until `succeeded`, and the history screen lists it.
3. `tokens.spec.ts`: create a `Read and write` token in Profile, copy it from the read-only input (Escape and an outside click do not close the dialog), call `GET /api/v1/auth/me` with `Authorization: Bearer` through Playwright's `request` (200), `POST` cells without a CSRF header (200), `POST /api/v1/me/tokens`, `POST /api/v1/workspaces` and `DELETE /api/v1/workspaces/{id}` with the bearer (each 403 `auth.session_required`), `PATCH /api/v1/auth/me` with the bearer (200); a request carrying the session cookie and `Authorization: Basic YTpi` is still signed in (200); create a `Read only` token: `POST` cells is 403 `auth.forbidden`, `POST /query` is 200; revoke in the UI; the call is 401; the Developer page shows the examples and the API reference link.
4. `mode.spec.ts`: Build/Use tabs switch sidebars; a deep link to a module opens Build, a deep link to a page opens Use; after using a page, reopening `/m/<id>` lands on the page; a viewer lands on the first page; `Apps > Pages` enters Use mode; the palette finds the page and the action after two characters.
5. Screenshots, light and dark (`screenshot`): page in Use mode with the context bar; the page editor with the palette open; each chart type; the KPI card (up and down); the import wizard on every step (Upload, Target, Map columns with a problem, Preview with highlighted cells, Run with progress, Run result with rejected rows); Actions, Processes and Import history pages and the details sheet; the tokens card and the secret dialog; the Developer page; the Build and Use sidebars. **Open each image with the Read tool and tick this list per image, fixing the UI when one item fails** (a failed item is a defect of the task that owns the screen, fixed here as a small commit): no clipped or overlapping text; no horizontal scroll at 1280 px; every control has a visible label or icon with a tooltip; text meets contrast in dark mode (no black on dark grey, no white on light grey); empty cells and rejected-row highlights are visible in both themes; charts show axes and a legend with the series colours distinct; the sticky context bar does not cover the first card.
6. Run the whole suite twice in a row (the specs share one database; each spec deletes what it creates or uses its own model).
7. Commit `test(e2e): pages, imports, exports, API tokens and modes`.

---

### Task Z1: Docs and conventions (Haiku)

**Wave 8. Depends on:** all other tasks. Haiku: the facts to write are listed; the wording is the implementer's; every number comes from the merged code (read the constants, do not copy them from this plan). **Hub files:** `CLAUDE.md`, `README.md`, `docs/deploy.md`.

**Files:** modify `CLAUDE.md`, `README.md`, `docs/deploy.md`.

**Interfaces — Consumes:** the merged code and tests of every other task; the names written into the docs must match them. Constants to read from the code before writing: `MAX_UPLOAD_BYTES`, `MAX_FILE_CELLS`, `MAX_XLSX_CELLS`, `MAX_ROWS`, `MAX_COLUMNS` (`crates/server/src/import/table.rs`, `xlsx.rs`), `CHUNK_CELLS`, the export caps (`export_api.rs`, `export_xlsx.rs`), `PENDING_UPLOADS_PER_USER`, `PENDING_UPLOAD_BYTES_PER_USER` (`import/uploads.rs`). "MB" in the docs means MiB (1,048,576 bytes), as in the code.

**Interfaces — Produces (what each file must say):**
- `CLAUDE.md` Global constraints: add the ten new stable codes with their statuses (`auth.session_required` 403, `token.not_found` 404, `token.name_taken` 409, `token.limit` 409, `import.upload_limit` 409, `import.too_large` 422, `import.unreadable` 422, `import.mapping` 422, `export.too_large` 422, `page.conflict` 409) to the problem-code list; note that actions and processes are part of the structure document and that `api_tokens`, `import_uploads`, `import_runs` and `pages` are tables (migrations `0005`-`0008`).
- `CLAUDE.md` Server conventions: `ModelAccess<A>` (markers `Viewing`, `Planning`, `Building`, `BuildingLocked`) is the extractor for a route under `/models/{id}`, including routes with more than one path parameter (the second is read with `ApiPath<(Uuid, Uuid)>`), and a single-value `ApiPath` must not be used there; a body-dependent role needs a second `handle_for` before any work; `ApiMultipart`; `AppError::PayloadTooLarge(Option<String>)`; `CurrentUser` accepts a bearer (`op_pat_…`, scopes `read`/`read_write`, `auth::READS_BY_POST`) and `SessionUser` is cookie-only (`auth.session_required`; the list is the `SESSION_ONLY` constant in `openapi.rs`); `housekeeping::run_hourly` is where purges go; `download::{attachment, csv_safe, sanitize_file_name}`; `query_api::read_window` is the one place cells are read for query and export; imports (the `ImportGate` pools are separate from the query `Work` permits; chunks of `CHUNK_CELLS`, not atomic across chunks; header-based mapping; `SourceCell` + the engine's `parse_cell`; a run is a detached task that outlives its request, answers `200` or `202`, and is followed through `GET /import-runs/{id}`; `import_runs` statuses; uploads deleted on use and after 24 h); the access sweep's `PLANNER_ONLY_GETS` and `auth::READS_BY_POST`.
- `CLAUDE.md` Web conventions: `uploadFile`/`downloadFile`/`saveBlob` for files; Build/Use mode is URL-derived (`features/build/mode.ts`), Use routes are `/m/$modelId/pages*`; the pages feature (`features/pages`: context selectors `?ctx.<ctxKey>=<member key>`, `ctxKey`, `applyContext`; the card query gate lives in `use-view-data`; a page definition is pruned on read and `pruned` is shown to builders); the data feature (`features/data`: the wizard, `RunReportView`, `invalidateAfterImport`); role predicates (`canEditPages`, `canEditActions`, `canRunImports`, `canImportItems`); query keys for pages, views, actions and processes sit under the structure key; chart tests use `web/src/test/charts.ts`; the web app reads server limits from `GET /api/v1/imports/limits` (`useImportLimits`) and never hard-codes the upload cap; the token secret dialog never closes on Escape or outside click.
- `README.md`: a line linking the interactive API reference at `/api/docs` and the in-app `/developers` page.
- `docs/deploy.md`: a section "Imports and exports behind a proxy" stating the limits as merged (file size, cell caps for CSV and XLSX, export caps for CSV and XLSX, one import run at a time per instance, a run can take tens of seconds and keeps going if the connection drops) and that a proxy or rewrite (such as the demo's Vercel rewrite) must allow request bodies and response times of that size, otherwise send large files to the API host directly; note that the controller verifies this on the demo before M4 merges. Two further notes in the same file: (1) **database space**: every changed cell of an import is one change-log row, so a 5,000,000-cell import adds on the order of a gigabyte on the hosted database (measure with the figure D2a2 recorded and quote it); (2) **basic-auth gates**: a gate in front of the app that sends `Authorization: Basic` on every request does not break cookie sign-in (a non-Bearer scheme is ignored), but API tokens then need a gate that lets `Authorization: Bearer` through.

**Steps**
1. Make the edits; check with `rg` that every file path, function, constant and component name mentioned in the new text exists on the branch, and that every number in `docs/deploy.md` equals the constant it names; run `rg -n "MAX_UPLOAD_BYTES|52428800" web/src` and confirm the only hits are generated types or test fixtures (no hard-coded cap in the app).
2. Commit `docs: M4 conventions, new problem codes and API reference links`.

---

## Spec changes

Amend `docs/superpowers/specs/2026-10-15-openplan-design.md` when M4 merges. Each block is worded to paste over the text it names. Numbers that are measured during M4 (file size, cell caps, export caps) are not written into the spec: the spec points to `docs/deploy.md`, which task Z1 fills from the merged constants.

**§1 Non-goals** (append to the non-goals paragraph): `Importing legacy Excel files (.xls, .xlsb), OpenDocument spreadsheets (.ods) and macro-enabled workbooks (.xlsm) is out of scope; save them as .xlsx or CSV first.`

**§2.1 Backend stack** (replace `calamine` (XLSX read), `rust_xlsxwriter` (XLSX write), `csv`,): `calamine` (XLSX read; .xlsx only), `rust_xlsxwriter` (XLSX write), `csv`, `encoding_rs` (text decoding of CSV files), `zip` (checks of XLSX packages),

**§3** (append to "Names are unique per kind within a model (case-insensitive)."): `Pages, actions and processes are kinds of their own; API token names are unique per user.`

**§6 table** (replace the `api_tokens` and `import_runs` rows, add `views`, `pages` and `import_uploads`):

| Table | Purpose |
|---|---|
| `api_tokens(id, user_id, name, scope, token_hash, last_used_at, expires_at, created_at)` | personal access tokens; `scope` is `read` or `read_write`; an expiry (1-365 days, default 90) is required; at most 20 unexpired tokens per user |
| `views(id, model_id, module_id, name, definition jsonb, is_default, created_by, timestamps)` | saved grid views of a module (added in M3) |
| `pages(id, model_id, name, definition jsonb, ordinal, created_by, timestamps)` | dashboard pages: context selectors and cards; a table, like saved views, so that editing a page does not touch the structure document |
| `import_uploads(id, model_id, user_id, file_name, kind, data bytea, created_at)` | files waiting for an import; deleted when a run uses them and after 24 hours; at most 10 per user |
| `import_runs(id, model_id, kind, parent_id, position, action_id, action_name, user_id, file_name, target jsonb, status, progress jsonb, report jsonb, created_at, finished_at)` | import history; `kind` is `import` or `process` (a process run's steps are import rows that point at it with `parent_id`); `status` is `running`, `succeeded`, `partial` or `failed`; `action_id` has no foreign key because actions live in the structure document; the newest 500 runs per model are kept |

**§6 `model_structure` row** (replace "and later views, pages, actions, processes, workflows and roles"): `and actions and processes (an action is a saved import mapping; a process is an ordered list of 1-10 actions), and later workflows and roles. Saved views and pages are tables of their own (views, pages).`

**§7 API table** (replace the Users/tokens, Views/pages and Data I/O rows):

| Area | Endpoints (indicative) |
|---|---|
| Users/tokens | CRUD `/users`; `GET`/`POST /me/tokens`, `DELETE /me/tokens/{id}` (browser session only) |
| Views/pages | CRUD `/modules/{id}/views`, `GET /models/{id}/views/{view_id}`, CRUD `/models/{id}/pages`, `POST /models/{id}/pages/reorder` |
| Data I/O | `GET /imports/limits`, `POST /models/{id}/imports/uploads`, `GET`/`DELETE …/uploads/{upload_id}`, `POST …/uploads/{upload_id}/suggest`, `POST /models/{id}/imports/preview`, `POST /models/{id}/imports/run`; CRUD `/models/{id}/actions`, `POST /models/{id}/actions/{id}/run` (multipart, one file); CRUD `/models/{id}/processes`, `POST /models/{id}/processes/{id}/run` (JSON naming one upload per step); `GET /models/{id}/import-runs`, `…/{run_id}`, `…/{run_id}/errors.csv`; `POST /models/{id}/export` (view → CSV/XLSX) |

**§7** (append after the tables): `API tokens authenticate with Authorization: Bearer op_pat_… and act as their owner with the owner's role in every workspace, authorized on every request. A token has a scope: read tokens may use GET and the POST endpoints that only read (query, members, cells/read, export, live ticket); read_write tokens may do anything their owner may except the session-only routes. Bearer requests need no CSRF header and never receive cookies. Token management, password change, user administration, workspace creation and deletion, and workspace member management are session-only: a bearer gets 403 auth.session_required. Imports are applied in chunks of at most 100,000 cells, each chunk one batch; a run is not atomic across chunks. A run belongs to a task of its own, not to the request that started it: the request waits up to 10 seconds and answers 200 with the report, or 202 with a run id that the client follows through GET /models/{id}/import-runs/{run_id}; one import runs at a time per instance, and a run that was in progress when the server restarted is marked failed.` In the first paragraph add to the example codes: `auth.session_required`, `import.mapping`, `import.unreadable`, `import.too_large`, `import.upload_limit`, `export.too_large`, `token.not_found`, `token.name_taken`, `token.limit`, `page.conflict`.

**§7 WebSocket** (replace "(cookie or token auth)"): `(opened with a ticket bought with a session cookie or a bearer token)`.

**§8.1 API tokens bullet** (replace): `API tokens: op_pat_<random>, shown once, stored hashed (SHA-256), Authorization: Bearer. A token has a scope (read or read_write), an expiry of 1-365 days (default 90), and its owner can have 20 unexpired tokens at most. A token stops working when it expires, is revoked or its owner is disabled; it keeps working after a password change (tokens are listed and revocable in the profile). A bearer request skips the CSRF check when it carries no session cookie, never receives Set-Cookie, and cannot reach token, password, user, workspace or workspace-member management (403 auth.session_required). An Authorization header with another scheme (for example the Basic header of an HTTP gate in front of the server) is ignored.`

**§9.1 Top bar bullet** (replace "avatar `DropdownMenu` (profile, tokens, theme light/dark/system, sign out)" with): `avatar DropdownMenu (profile, developers, theme light/dark/system, sign out; API tokens are managed on the profile page and the Developers page shows the API reference and token examples)`; and (append to the same bullet): `The mode is derived from the address: the pages routes (/m/{id}/pages…) are Use, every other model route is Build. The last mode used in a model only chooses where /m/{id} lands (Use on the first page when the model has pages and the mode was Use, or, with nothing stored, the user is a planner or viewer; otherwise Build).`

**§9.2** (replace the Apps group text): `Apps (Pages, which opens Use mode; Workflows from M5)`; and in the Data group the Import history entry is shown to planners and above.

**§9.5** (append): `Import is for builders; planners see it disabled with the reason, and in a production model it is disabled with the production-mode message.`

**§9.7** (append):
`Context selectors drive only the dimensions that are on a card's pages; a card whose module has the dimension on its rows or columns, or lacks it, is not affected and the card's config says so. A selector's options are the members of the dimension (the subset, when a card uses a subset of the list); the chosen members live in the address as ?ctx.<list id|time|versions>=<member key>. Card ids are assigned by the server. Pages follow the saved-views rule for things that were deleted: when a page is read, a card whose module, saved view, line item, dimension, action or process no longer exists is left out (and so is a selector whose list no longer exists), the page tells builders that something was removed, and saving the page removes it for good. A KPI has an "invert colors" option for measures where a decrease is good. Text cards render sanitized Markdown (no raw HTML, images shown as links); image cards load https images without a referrer. A page edited by two people at once is refused with a conflict message instead of overwriting.`

**§9.8** (replace the paragraph): `Dialog with stepper: 1) upload (drag-and-drop zone; .csv, .tsv, .txt and .xlsx; sheet picker for XLSX), 2) choose target (items of a list, or the values of a module), 3) map columns (Select per column by header name; auto-match by name; number format; "blank cells clear values"; for modules, "fixed values" give a dimension that has no column in the file a member of its own, and "values are spread across columns" maps the headers of a column group, such as one column per month, to members of one dimension), 4) preview the first 100 rows in Table with problem cells highlighted, 5) run, with a progress bar when the import takes longer than a few seconds; the result shows counts (imported, rejected, blank), the first rejected rows and "Download error report" (the first 10,000 rejected rows with their original values). A row is applied whole or not at all; a mapped column that is blank leaves the value unchanged. "Save as action" (builders) stores the mapping when the import starts, whatever the outcome of the run; the mapping matches columns by header name, so a later file with the columns in another order imports correctly and a file with a renamed or missing mapped column is refused with the missing and unexpected columns listed; an action that maps month columns by name needs a new mapping for next year's file. Processes run several actions in order, one uploaded file per step. File size and cell limits are listed in the deployment guide, returned by GET /imports/limits and shown in the refusal message.`

**§11** (append): `Pages and saved views are tables, not part of the structure document: ALM revisions, diff, sync, model copy and the .openplan file (pages.json, views) must include them. Actions and processes are in the structure document and travel with it.`

**§12 imports bullet** (replace): `Imports never fail silently: each rejected row is recorded with its row number, column, reason and original values (the first 10,000 are kept and downloadable as an error report, with a flag and the true count when there are more). Rows are applied in chunks of at most 100,000 cells, each chunk one batch; a run is not atomic across chunks. Status is succeeded (nothing rejected), partial (something applied and something rejected or failed), failed (nothing applied) or running; a run that the server loses by restarting is marked failed with the rows applied before that kept, and the history shows every run.`

**§15 M4 row** (replace the Deliverables cell): `Page builder and cards, charts, KPI, context selectors, import wizard, actions, processes, export CSV/XLSX, API tokens, OpenAPI docs (the interactive reference at /api/docs and a Developer page with token examples), Build/Use mode`

## Notes for later milestones

- **M5:** the one place cell data is read for query and export is `query_api::read_window`; page cards and the export use `POST /query`/`read_window`, so selective access, DCA and the other rules change only there. Locked cells become one more per-row rejection reason in `import::resolve::resolve_row` and D2a1's chunk preparation. A read token keeps working for `READS_BY_POST` routes only; add the M5 read-only POSTs to `auth::READS_BY_POST` (the access sweep and the scope check share it). New model routes take `ModelAccess<A>`. M5 migrations start at `0009`.
- **M6:** ALM revisions, diff, sync, model copy and the `.openplan` file must include the `views` and `pages` tables (actions and processes are in the structure document); `import_runs`, `import_uploads` and `api_tokens` are not part of a model file.
- **M7/M16:** forecasting and connectors add new kinds of action: `Action` gains a kind field then (serde default keeps stored documents loading); scheduled imports reuse `run_import`, which already runs detached from any request.

## Judgment calls the controller may overrule

Accepted at the previous round (listed so they stay visible): pages in a table with `ProdLock::Ignore` and a §6 amendment (if the document is wanted, P1 becomes an engine task like A0 and pages lose the `updated_at` conflict check); `suggest` is a change-class route and not in `READS_BY_POST`; E1 and A0 are in wave 0; a bearer plus a session cookie is still CSRF-checked.

1. **Two import pools (V2).** Ruling V2 says one import run at a time and the permit is taken after the upload body is received; I did exactly that for `run`. Previews, sheet listings and `suggest` also parse a 50 MiB file, and making them wait behind a run that lasts minutes would freeze the wizard, so I added a second pool, `read` (2 permits), instead of putting them in the run pool. The budget in Decision 1 counts one run and two reads.
2. **XLSX measurement in D1b, not D1c (V4).** The ruling says "D1a/D1c"; D1c is the mapping DTO and reads no file. The XLSX reader is D1b, so its allocation test and `MAX_XLSX_CELLS` are there; D1a1 and D1a2 measure CSV and upload, and D2a2 asserts the whole inequality.
3. **Process runs by upload id (V4).** To keep every body small, a process run names uploads made earlier. That needed a larger pending quota (10 uploads and 200 MiB per user, was 5) and a cap of 10 steps (was 20); both are in the Constants table.
4. **`fixed` members in the mapping (minor 25).** A file with no Versions or Time column could not be imported into a module with that axis. I added `mapping.fixed` (A0, D1c rules S9 and S11, R1a, the wizard's Fixed values control). It is a small addition to the mapping and no other scope.
5. **Wizard in two halves.** I1a1 ships a working import (upload, target, auto-matched mapping, run, report) and I1a2 adds the mapping editor, preview, edit-mapping mode and the entry points; I1a2 waits for I1b1 because it adds buttons to the Actions page that I1b1 creates. The read hooks for actions and processes are in I1a1 so I1b1 and I1b2 do not collide.
6. **S0 is Sonnet.** It now carries shared server code (`ModelAccess`, `READS_BY_POST`, `housekeeping`, the import skeleton) as well as the harness, so it is not a Haiku task under the CLAUDE.md policy.
7. **D2b is not split.** The review calls it borderline once D1a and D2a are split; the process run is now a small JSON route, so it stays at about 1,400 lines.
8. **`pruned` for pages, `broken` for actions (V11).** Pages are pruned on read as saved views are. Actions and processes are structure that a builder edits, so they keep a `broken` list and refuse to run instead of disappearing.
9. **Token `read` rule** is implemented as "GET/HEAD/OPTIONS plus the `READS_BY_POST` list" with `403 auth.forbidden` ("This token can only read."), not a new code. `PATCH /auth/me` (profile name) and `PATCH /workspaces/{id}` (rename) accept a `read_write` token.
10. **Process steps may repeat an action**; each step's file is named by its position.
11. **Import history is Planner+** (reports hold cell values from files), with explicit `PLANNER_ONLY_GETS` sweep entries.
12. **CI steps per test file.** Each task that creates a release-mode test file adds its own CI step, so no step names a file that does not exist yet.
13. **An import-limits route (v3-check ruling).** The ruling says T3 reads the upload cap from the server and never hard-codes it, but no route returned it. D1a2 now serves `GET /api/v1/imports/limits` (the constants only, any signed-in user), F1 adds the query key, T3 adds `useImportLimits`; D1b adds `max_xlsx_cells` to the same answer.
14. **Memory bound 310 MB (v3-check ruling).** 512 MB minus about 150 MB for the server and models minus the 50 MB margin is 312, rounded down to 310. Since R is at least P, P alone must stay at or below 100 MB. If the measurements cannot meet this, the constants fall (that is the point of measuring).
15. **`save_as` is created before the run (W4).** The action exists as soon as the import starts and stays whatever the outcome (a failed run, a dropped request). Saving only after a successful run would need the detached task to own it; I took the ruling literally.
16. **Two same-wave dependencies.** P2a1 needs D3b (wave 2) for the card menu's XLSX item and I1a1 needs D2b (wave 5) for the `errors.csv` download. Both are declared, and the wave graph says the table order settles them, instead of moving three more waves.
17. **D2a2 no longer depends on R1b (W1).** `Plan` is in R1a now and reaches D2a2 through D2a1; D2a2 depends on D1b instead, because its tests run XLSX files. R1a is the largest server task after P1 (about 1,500 lines).

## Findings resolved (first review, 50)

Severity: C critical, I important, M minor. Every finding is resolved; "ruling" marks where a ruling replaced the review's remedy. None is rejected. Task names are those of this version.

| # | Sev | Where resolved |
|---|---|---|
| 1 | C | Ruling C1: D2a1 (chunk planner, `partial`), D2a2 (chunks, detached run), D1a1/D1a2/D1b (measured caps, `import_memory.rs`), Review Focus 1; the review's "refuse above 100,000 cells" remedy replaced (ruling) |
| 2 | C | Ruling C2: A0 (`ColumnSource` header/index), D1c (F1-F3, missing/unexpected), R1a (reordered columns), D2b (saved action re-run, renamed header refused) |
| 3 | I | T1a/T1b: `SessionUser`, scopes `read`/`read_write`, `403 auth.session_required` (ruling I3 replaced the review's `auth.forbidden`) |
| 4 | I | T1b: explicit CSRF rule and tests, Authorization handling, no `Set-Cookie`, OpenAPI two requirements and updated tests |
| 5 | I | S0: byte, header and multipart harness, `ModelAccess`, e2e `withApi`/upload/download/xlsx helpers |
| 6 | I | Decisions 6 and each migration task: `0005`-`0008`, one per task (ruling I6 replaced the review's two files), FK indexes, `ON DELETE`, `lower(name)` unique, RLS |
| 7 | I | D3a, D3b, N1 and P1 Sonnet; Haiku only for T3 and Z1 (Decision 7) |
| 8 | I | P1 (`pruned` on read), A1 (`broken` on actions), delete tests in P1/A1, D2b (broken action refused) |
| 9 | I | A0: processes are an ordered list in the structure document with engine integrity (ruling I23 replaced the review's `process_steps` table); D2b process run by upload ids |
| 10 | I | D1a2: `ApiMultipart`, caller checks before the body (`ModelAccess<Planning>`), per-route body limits, memory test |
| 11 | I | Global Constraints text safety; NUL tests in D1a1, D1a2, D1b, D2a2; the run is saved by its own task and returns a warning if saving history fails |
| 12 | I | D1a1 (CSV, UTF-16 via `encoding_rs`, streaming), D1b (`Xlsx::new`, zip guards, streaming cells, `catch_unwind`, `.xls` refused); formats `.csv .tsv .txt .xlsx` instead of the review's `.csv .xlsx` (ruling I10-I14); crates in Tech Stack |
| 13 | I | D1a2: owner/model lookup, quota 10 and 200 MiB, purge in `housekeeping`, deleted on use (D2a2) |
| 14 | I | D1a2/D1b `GET upload?sheet=&has_header=`, D1d `POST suggest`, `header_row` dropped (A0 `has_header`) |
| 15 | I | R1a (resolve outside the actor), D2a1 (generation check, scratch clone, duplicates, ambiguity, `check_cells`), D2a2 (actor-stall timing test) |
| 16 | I | Endpoint table; D2a2/D2b second `handle_for` before any work, `save_as` pre-check; `PLANNER_ONLY_GETS` (S0, D1a2, D2a2, D2b); `READS_BY_POST` (S0, D3a) |
| 17 | I | D2a1 report (`rejected_kept`, `rejected_truncated`, statuses, original values), D2b errors.csv truncation line and process continues on `partial` |
| 18 | I | D3a `csv_safe`, D3b typed XLSX writers, BOM, file and sheet names; D2b errors.csv |
| 19 | I | D3a `ExportRequest` with `ViewDefinition`, 1,000 x 200 windows, `read_window`, `Work` permit; D3b constant-memory XLSX and 500,000-cell cap |
| 20 | I | E1 typed `SourceCell` and engine parser with shared vectors; R1a/R1b/D2a2 percent-trap tests; blank handling |
| 21 | I | A0/D1c/R1a: `member_values` column group, `ImportDim`; tall layout out of scope (ruling I21 replaced "declare out of scope") |
| 22 | I | D4 (Export menu), T3 (Developer page), Server acceptance (OpenAPI per task), Z1 (codes) |
| 23 | I | Decisions 8 and 20, Spec changes (§6), M6 note, Judgment calls (ruling I23 replaced the review's "tables for all three") |
| 24 | I | Wave graph with hub files per task |
| 25 | I | P1 (`inverted`, server-assigned card ids), P2b1/P2b2 (windows and footers) |
| 26 | I | P2a1 (`ctx.ts`, `applyContext`, options, URL form), P3a2 (notes) |
| 27 | I | T1a/T1b tests (hash, cap 20 not 25, expiry required, scopes, removal from workspace, password change keeps tokens, purge) and T2 (secret dialog, states, copy) (ruling I27) |
| 28 | M | S0 (`ModelAccess` replaces the `Planner` field exposure); D2a2 uses a second `handle_for` instead of a Builder sibling extractor |
| 29 | I | Precondition (M3 + G4 merged), F1 keys, P1 `GET view`, P2a1 resolves `view_id` and shows `pruned` |
| 30 | M | P2a1 query gate (4 in flight) and `staleTime`; P2b2 at most three small KPI queries; `503` test |
| 31 | M | Web acceptance (three states per data view), per-task state tests, P2c disabled action for viewers |
| 32 | I | P3a1: pure `layout.ts`, library only through `onLayoutChange`, drag handle, 2.x pin, mobile stack, `DiscardChangesDialog` and blocker |
| 33 | I | N1 (URL-driven mode, landing matrix, `BuildPath`, sidebars, header, palette, redirect) |
| 34 | I | F1 `uploadFile`/`downloadFile`/`saveBlob` |
| 35 | M | I1a1/I1a2/I1b1/I1b2 split, conventions in Web acceptance, role predicates in F1 |
| 36 | M | S0 (`exceljs`, helpers), X1 (fixtures and helpers) |
| 37 | M | Tech Stack pins (`calamine 0.36`, `rust_xlsxwriter 0.99`, `react-grid-layout ^2.3.0`, `encoding_rs`, `zip`) |
| 38 | M | Z1 `docs/deploy.md` section; verification on the live demo is a controller step before merge |
| 39 | M | A0 `decimal`, E1 `decimal_comma`, I1a2 Number format select |
| 40 | M | P1 `updated_at` and `page.conflict`, P2a1/P3a1 New page and conflict dialogs |
| 41 | M | P2a2 image and Markdown hardening |
| 42 | M | T1a `housekeeping.rs` call, D1a2 upload purge |
| 43 | M | D2a2 `import_large.rs` (`#[ignore]`, release in CI) plus small default runs |
| 44 | M | A0 mapping has no `header_row`; `has_header` is a real control (I1a2) |
| 45 | M | R1a and D2a1: per-row validation in `resolve_row` and the chunk check, noted for M5 |
| 46 | M | Z1 |
| 47 | M | D1d `fold`, second header stays unmatched |
| 48 | M | D1b 1900/1904 systems and serial 60 tests |
| 49 | M | F1 predicates; I1a1 disabled-with-reason for planners and production mode |
| 50 | M | N1 palette: pages and actions after 2 characters |

Review sections 4 and 5: cascade delete is task L2 (wave 1); the WebSocket ticket by bearer is tested in T1b; the OpenAPI docs deliverable is T3.

## Findings resolved (second review of v2: 12 Important, 21 Minor)

Ruling numbers V1-V12 are the coordinator's rulings on that review. Every finding is resolved; none is rejected. The splits (finding 12) are listed in their own table below.

| # | Sev | Finding | Where resolved in v3 |
|---|---|---|---|
| 1 | I | `UploadCaller` takes one path parameter | V1: S0 `ModelAccess<A>` on `RawPathParams` (the segment named `id`) with markers and a two-parameter test route; Decision 25; the Endpoint table has an Extractor column; D1a2 step 2, D2a2 step 7 and D2b step 1 test a valid planner on the two-parameter routes; P1 writes its own extractors on `ModelAccess` and does not reuse `Reader`/`Writer` |
| 2 | I | The query `Work` pool serves slow uploads and long runs | V2: D1a2 `ImportGate` (`run` 1 permit, `read` 2 permits, separate from `Work`; `run` taken after the body is received); Decision 14; Constants; D1a2 step 3 (held import slot gives `503` while `POST /query` still works); D2a2 step 2 |
| 3 | I | A run lives and dies with its request | V3: D2a2 `run_import` spawns a detached task, `200`/`202`, `GET import-runs/{id}`, `fail_interrupted` at startup, dropped-request test; D2a1 `runs.rs` (`running` row, progress); D2b process task; Decision 13; Review Focus 9; I1a1/I1b1/I1b2/P2c follow `202` by polling; Spec changes §7, §12 |
| 4 | I | Memory budget measured for CSV only | V4: D1b streaming XLSX reader (counting pass, 100-row sample, `MAX_XLSX_CELLS`, `#[ignore]` allocation test); D2b process bodies are at most 64 KiB (uploads by id); D1a1/D1a2 record P, D2a2 asserts `R + 2P <= 310 MB`; Decision 1; Judgment call 2 |
| 5 | I | Session-only list omits two instance-admin routes | V5: T1a/T1b (`POST /workspaces` and `DELETE /workspaces/{id}` added; 12 routes in one `SESSION_ONLY` constant, counts derived from it); `PATCH /auth/me` decided (allowed); Decision 3; Endpoint table note; Spec changes §7, §8.1; T2/T3 copy |
| 6 | I | S0 cannot pass its gate without the `multipart` feature | V6: S0 modifies the workspace `Cargo.toml`; D1a2 no longer does |
| 7 | I | Hidden dependencies and wrong "parallel" claims | V7: S0 creates `auth::READS_BY_POST`, `housekeeping::run_hourly`, the `import/mod.rs` skeleton and `features/data/api.ts`; hub lists name `import/mod.rs`, `page-view.tsx`, `features/data/api.ts`, `.github/workflows/ci.yml`; D1a1 and D1c depend on S0; D2b depends on D1d; the parallel pairs are re-derived; I1a2 now waits for I1b1 (it edits the Actions page) |
| 8 | I | P2a links to a route created three waves later | V8: P2a1 has no history link; P2c adds `View history` (route from I1b1) |
| 9 | I | The query gate cannot reach the grid cards | V9: P2a1 puts the gate in `use-view-data.ts` and passes it through `Grid`; the 6-cards-4-in-flight test runs against it |
| 10 | I | Chart tests cannot run in jsdom | V10: P2b1 tests `chartData`, `waterfall`, `tooltipText` directly; rendering tests install `web/src/test/charts.ts` (fixed-size `ResizeObserver` and `ResponsiveContainer` in that file only) |
| 11 | I | P1 is Haiku but not fully pinned | V11: P1 is Sonnet; pruning on read with `pruned`, context entries dropped, `default_key` format, extractors and the per-card check order are pinned |
| 12 | I | Twelve tasks are over one session | V12: splits, see the table below |
| 13 | M | A0 names literals that do not exist | A0 Files and step 2 (only `export_structure` builds the literal) |
| 14 | M | A0 `structure_changed` cost | A0 integrity bullet states the cost and why it is accepted (actions change rarely; pages avoid it by being a table) |
| 15 | M | Page `context[]` has no broken handling | P1 pruning of context entries and step 4 (delete the list); Decision 8; P2a1 |
| 16 | M | Three spellings of a list dimension; two `dimKey` | P1 context `dim` and A0/D1c `ImportDim` use the `ViewDimDto` spelling; P2a1 names the URL helper `ctxKey` (G4's `dimKey` is untouched) |
| 17 | M | D2a status definitions overlap | D2a1 status rules (an all-blank file is `succeeded` with the warning `No values to import…`); I1a1 `RunReportView` sentence for 0 applied |
| 18 | M | Report and change log bounded by count, not bytes | D2a1 value trimming keeps the stored report under 8 MiB (test with 10,000 rows of 500 long values); D2a2 step 3 prints the change-log size per cell; Z1 `docs/deploy.md` states the database cost |
| 19 | M | `engine_check` on `InvalidCoordinate` | R1a `engine_check_module`: attribute by the error's `index`, re-check at most 3 passes, else `Err` that D2a2 turns into the run's `failure`; step 2 |
| 20 | M | List imports run the upsert twice, untimed | List chunks hold at most 10,000 items (`LIST_CHUNK_ITEMS`, Decision 11); D2a2 step 3 times a 100,000-item list import under a parent list |
| 21 | M | Memory test is a debug test; "to be measured" numbers in messages | D1a1/D3a/D2a2 each keep a small debug case and an `#[ignore]` full-size case with its own CI step; messages are built from the constants (D1a1 `check_size`, D1a2 413 detail); T3 and Z1 read the merged constants; "MB means MiB" in Tech Stack |
| 22 | M | Endpoint table vs task text | Endpoint table adds `503` (preview and others) and `400 bad_request`; Server acceptance requires every table code in the OpenAPI responses |
| 23 | M | Zip ratio of 100 refuses real workbooks | D1b: ratio judged only for entries over 16 MiB and over 1,000; total-size guard bounds a bomb; tests at ratio 300 (accepted) and 2,000 (refused) |
| 24 | M | Any `Authorization` header that is not a bearer is a 401 | T1a/T1b: only the `Bearer` scheme counts, others are ignored; tests with `Basic`; Decision 4; Spec change §8.1; Z1 `docs/deploy.md`; X1 `tokens.spec.ts` |
| 25 | M | No way to import without a Time or Versions column | `mapping.fixed` (A0, D1c S9/S11, R1a, I1a2 Fixed values, X1 step 2d); Judgment call 4 |
| 26 | M | Preview shows source strings, not stored values | R1b `warnings` for typed XLSX numbers outside -1 to 1 meeting a percent line item; E1 rules; the preview marks problems per cell |
| 27 | M | `has_header: false` has no source of columns | D1a2 `GET …/uploads/{id}?sheet=&has_header=`; I1a2 header-row switch refetches |
| 28 | M | `ColumnSource::Index` is 0-based; messages say `Column N` | A0 states `Column {index + 1}`; D1c F3 (`n = index + 1`); R1a `Problem.column` |
| 29 | M | File-list and count mismatches | Server acceptance: `schema.d.ts` is part of every server task's Files; D3a Files include `export_memory.rs`; S0 owns `model_access.rs`; T1b counts the routes from the constant |
| 30 | M | P2a has no rendering for chart and KPI | P2a1 `UnavailableCard` for every kind it does not render; P2a2, P2b1, P2b2 replace it kind by kind and P2c deletes it |
| 31 | M | Spec-change wording | Spec changes §1 (adds `.xlsb`), §9.1 (Top bar bullet, tokens on the profile page, Developers) |
| 32 | M | Two `AppError` additions under-specified | T1a `AppError::SessionRequired`; T1b `AppError::ForbiddenWith(String)` (403 `auth.forbidden` with a detail) for `This token can only read.`; D1a2 extends `AppError::PayloadTooLarge` to `PayloadTooLarge(Option<String>)` instead of adding `TooLarge` |
| 33 | M | A saved wide-file action pins specific headers | I1a1 and I1a2 save-as sentences, I1b1 Actions page tooltip, Spec changes §9.8 |

**Finding 12, splits (V12).**

| v2 task | v3 tasks | Seam |
|---|---|---|
| D2a | D2a1, D2a2 | pure chunk planner, report and run repository (no route) / endpoint, detached lifecycle, roles and large tests |
| D1a | D1a1, D1a2 | CSV reading, `Sheet`, size and memory (no route) / uploads, `ApiMultipart`, import gate, routes |
| R1 | R1a, R1b | module and list rows, `Plan`, column groups, duplicates, engine check / the preview endpoint (the list half moved to R1a by ruling W1) |
| D3 | D3a, D3b | download helpers, `read_window`, CSV / XLSX writer and memory |
| T1 | T1a, T1b | table, CRUD, `SessionUser`, purge / bearer authentication, scopes, session-only routes, OpenAPI |
| P2a | P2a1, P2a2, P2c | shell, list, context, grid card, gate / text and image cards / action card (needs the data screens) |
| P3a | P3a1, P3a2 | layout, canvas, draft, save, guard, page menu / palette, config forms, page selectors |
| P2b | P2b1, P2b2 | chart card / KPI card |
| I1b | I1b1, I1b2 | Actions and history screens / Processes screen |
| I1a | I1a1, I1a2 | shell, upload, target, run, report / mapping, preview, edit mode, entry points |
| D2b, P1 | unchanged | borderline in the review; D2b is smaller now that process runs take upload ids, and P1 is Sonnet (V11) |

## Findings resolved (check of v3: 5 Important, 7 Minor)

Ruling numbers W1-W5 are the coordinator's rulings on that check; the Minors were applied as proposed, plus the three additions in the rulings (a memory margin of at least 50 MB, one run permit per process, the upload cap read from the server). Every finding is resolved; none is rejected.

| # | Sev | Finding | Where resolved |
|---|---|---|---|
| 1 | I | D2a1 consumes R1b's `Plan` but depends only on R1a | W1: R1a now holds `ListPlan`, `resolve_list_row`, `Plan`, `resolve_row`, the list-row rules and their tests (about 1,500 lines); R1b is the preview endpoint only (about 500 lines); D2a2 drops R1b and adds D1b; wave table, hub lists and the Split table updated; (R1b, D2a1) is now a true parallel pair |
| 2 | I | D1d's test needs the XLSX reader from its parallel sibling D1b | W2: D1d step 1 drops the XLSX case and tests a `sheet` on a CSV upload instead (`422`, "This file has no sheets."); D2b step 4 runs the XLSX round trip through `suggest` with a `sheet` |
| 3 | I | Migration numbers not in wave order | W3: Decision 6, File structure, P1 Files (`0006_pages.sql`), D1a2 Files (`0007_import_uploads.sql`); `0005` and `0008` unchanged; Z1's "0005-0008" stays true |
| 4 | I | `save_as` lost when the run answers `202` or the request is dropped | W4: D2a2 `imports/run` creates the action after `check_mapping` and before `runs::start` and passes it in `RunLabel.action`; `action_id` is in the `200` and the `202`; step 7 tests the `202`, dropped-request and failed-run cases; Endpoint table; I1a1 sentence; D2b action run; Spec changes §9.8; Judgment call 15 |
| 5 | I | XLSX measurement skips the shared-strings worst case | W5: D1b adds the `xl/sharedStrings.xml` size guard (`MAX_SHARED_STRINGS_BYTES`, start 64 MiB), a text-heavy fixture in step 5 and refusal tests in step 3; `MAX_XLSX_CELLS` is set from the worse of the two fixtures; Constants rows; D2a2 step 3 runs the text-heavy file |
| 6 | M | S0 cannot pass its own gate | S0 Files: `tests/auth.rs` (the purge test spawns `housekeeping::run_hourly`), `PURGE_INTERVAL` moves, `ProdLock` becomes `pub`; `run_hourly` purges at start and hourly; step 5 runs `--test auth` |
| 7 | M | A process step cannot reuse `run_import` without giving up the permit | D2a2 `execute_import(&state, user_id, &handle, run_id, &permit, file, &mapping, &label)` is the task body and `run_import` the spawn wrapper; D2b's process task takes the permit once and calls `execute_import` per step |
| 8 | M | I1b2 re-adds hooks I1a1 created | I1b2 Files extend `api.ts` with `useSaveProcess`, `useDeleteProcess`, `useRunProcess` only; predicates come from F1 |
| 9 | M | Consumers that do not list the task they consume | D1b lists D3b, D2a2 lists D1b, P2a1 lists D3a (and says D3b merges first), I1a1 lists D2b; wave table rows and the same-wave note in the Wave graph |
| 10 | M | Memory budget has no margin | Decision 1: 512 - 150 - at least 50 = 310 MB for `R + 2P`; D1a1 step 3, D1a2 step 8 (P at most 100 MB), D1b step 5, D2a2 step 3, Constants row; Judgment call 14 |
| 11 | M | Small Files and hub-list mismatches | D2a2 hub list and wave row name `tests/access_sweep.rs`; D2a1 hub list drops `lib.rs`; D1b names `import/table.rs` for `ACCEPTED_EXTENSIONS`; P2a2 names `page-view.tsx` only |
| 12 | M | T3 hard-codes a constant that later tasks may lower | Ruling instead of the check's Z1 re-run: D1a2 serves `GET /api/v1/imports/limits`, F1 adds `queryKeys.importLimits`, T3 reads the cap through `useImportLimits` (skeleton and failure sentence tested); Z1 checks that no cap is hard-coded in `web/`; Endpoint table and Spec changes §7, §9.8 |
