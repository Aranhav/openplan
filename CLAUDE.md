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
pnpm --dir web dlx shadcn@latest add <component>   # add a shadcn/ui component (style new-york, base color neutral)
```

Web conventions:

- Call the API through `api` and `unwrap` from `web/src/lib/api/client.ts`. `api` is typed from the generated `schema.d.ts` and has `/api/v1` as its base URL, so paths are written without that prefix (`api.GET("/setup/status")`). `unwrap` throws `ApiError` for problem+json responses.
- Query keys come from `web/src/lib/api/keys.ts`.
- `web/src/routeTree.gen.ts` (TanStack Router) and `web/src/lib/api/schema.d.ts` are generated and committed. Do not edit them by hand.
- `web/src/components/ui/` is managed by the shadcn CLI. Do not edit it by hand.
- Routes: `web/src/routes/` files stay thin and pages live in `web/src/features/<name>/`. Anything that needs a signed-in user goes under the `_app` layout route (`routes/_app.tsx`, and `routes/_app/*` for its children); its `beforeLoad` redirects to `/setup` or `/login` and puts the user on the route context as `context.me`. Auth queries and mutations (`meQuery`, `useLogin`, `useLogout`, ...) are in `web/src/features/auth/api.ts`. `/login` and `/setup` have guards too (a fresh instance goes to `/setup`; a signed-in user leaves `/login`). Always build a post-login target with `safeRedirectPath` and the `/login` search with `loginSearch` (`features/auth/redirect.ts`), and set a per-screen title with `useDocumentTitle` (`hooks/use-document-title.ts`).
- Router defaults: `createAppRouter` installs the app-wide error screen (with Try again), pending spinner and not-found page, and watches for session expiry: a 401 from any query or mutation (except a failed sign-in) clears the query cache and goes to `/login`. Do not add per-route 401 handling. Navigations that leave a signed-in page for `/login` (expiry, logout) replace the history entry so Back does not return to a page that only bounces.
- Query client: `createQueryClient()` (`lib/query-client.ts`) retries network failures and 5xx twice and never retries a 4xx.
- Errors: `unwrap` throws `ApiError` (`status`, `code`, `detail`, `errors`, `retryAfter` in seconds from `Retry-After`). A fetch that never reaches the server becomes an `ApiError` with status 0 and code `network`. Use `errorDetail(error)` for text to show in a toast.

Web testing:

- Tests are Vitest with jsdom, Testing Library and `@testing-library/user-event`; the setup file is `web/src/test/setup.ts`.
- API calls are mocked with msw (v3), not by stubbing `fetch`. `web/src/test/server.ts` exports the shared server; the setup file starts it with `onUnhandledFrame: "error"` (any request without a handler fails the test) and resets handlers after each test. Add handlers per test with `server.use(http.post("/api/v1/auth/login", () => ...))` and build error responses with `problem()` from `web/src/test/problem.ts`.
- Vitest runs with `clearMocks: true`, so `vi.fn()` call counts reset between tests.
- `renderWithProviders(ui)` from `web/src/test/render.tsx` renders a component inside a query client and an in-memory router at `/host`; any other path renders a placeholder, so assert navigation with `router.state.location.href`. To test the real route tree use `renderApp(path)` and `mockSession({ needsSetup, signedIn })` from `web/src/test/app.tsx` (the returned session object can be changed mid-test, e.g. to sign out).
- Mock `sonner` with `vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))` when a test asserts on a toast.

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
