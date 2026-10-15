# OpenPlan

OpenPlan is an open-source, Anaplan-style connected planning platform: a Rust (axum) server with a Postgres store and a React web app, shipped as one binary.

## Layout

```
Cargo.toml          Cargo workspace (members = ["crates/server"])
crates/server/      package openplan-server, binary `openplan` (HTTP API, migrations, embedded web UI)
web/                Vite + React + TypeScript app (served by the server from web/dist)
e2e/                Playwright end-to-end tests that drive the real server
docker/, compose.yml  container image and local compose stack
docs/superpowers/   product design spec and implementation plans
```

## Commands

Server (from the repo root):

```
cargo run -p openplan-server -- serve      # needs DATABASE_URL and OPENPLAN_PUBLIC_URL
cargo run -p openplan-server -- openapi    # print the OpenAPI document; needs no env or DB
cargo test -p openplan-server              # export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres first
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check
```

Server configuration comes from `DATABASE_URL`, `OPENPLAN_PUBLIC_URL`, `OPENPLAN_BIND` (default `0.0.0.0:8080`) and `OPENPLAN_LOG` (default `info`).

Web:

```
pnpm install
pnpm --dir web dev          # Vite on :5173, proxies /api to :8080
pnpm --dir web build
pnpm --dir web lint
pnpm --dir web typecheck
pnpm --dir web test
pnpm --dir web gen:api      # regenerate web/src/lib/api/schema.d.ts from the server OpenAPI document
```

End to end and containers:

```
pnpm --dir e2e test         # run `pnpm --dir web build` and `cargo build -p openplan-server` first
docker compose up --build   # OpenPlan on http://localhost:8080 with Postgres
```

## Global constraints

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
- Commits: conventional commit subject; every commit message ends with the `Co-Authored-By: <model> <noreply@anthropic.com>` and `Claude-Session: <session url>` trailers.
