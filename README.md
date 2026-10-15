# OpenPlan

OpenPlan is an open-source, Anaplan-style connected planning platform for finance teams and model builders. A Rust server with a Postgres store serves a React web app, and the whole thing ships as one binary you can self-host with Docker Compose.

## Status

- [x] **M1 Foundation:** first-run setup, sign-in with sessions and CSRF protection, user administration, workspaces with roles, models, and the app shell (sidebar, command palette, light and dark themes), with Docker, CI and end-to-end tests.
- [ ] **M2 Engine:** lists, time, versions, modules, line items and the formula language.
- [ ] **M3 Grid and blueprint:** the grid, views, the formula editor and live updates.
- [ ] **M4 Pages and data:** dashboards, charts, imports, actions, exports and API tokens.
- [ ] **M5 Security and workflow:** model roles, selective access, period locks, workflows and OIDC.
- [ ] **M6 Collaboration and ALM:** comments, presence, audit log, revisions and model files.
- [ ] **M7 Advanced:** scenario sandboxes, forecasting and AI features.
- [ ] **M8 Launch:** demo model, documentation and release images.

## Quick start

You need Docker with the Compose plugin.

```
docker compose up --build
```

Open http://localhost:8080 and complete the first-run setup to create the admin account and your first workspace. Compose runs OpenPlan next to its own Postgres; the data lives in the `pgdata` volume, and `docker compose down -v` removes it.

## Development

You need Rust (stable), Node.js 22, pnpm 10 and a Postgres 16 or newer.

```
# Postgres, if you have none running
docker run --name openplan-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:17

export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
export OPENPLAN_PUBLIC_URL=http://localhost:5173

cargo run -p openplan-server -- serve   # API on :8080
pnpm install
pnpm --dir web dev                      # web app on :5173, proxies /api to :8080
```

Tests and checks:

```
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test                              # uses DATABASE_URL
pnpm --dir web lint
pnpm --dir web typecheck
pnpm --dir web test
```

The end-to-end tests drive the real server in Chromium and use the `postgres` login above (override it with `E2E_ADMIN_DATABASE_URL`). Install the browser once, then build the web app and the server before each run:

```
pnpm --dir e2e exec playwright install chromium
pnpm --dir web build && cargo build -p openplan-server
pnpm --dir e2e test                     # screenshots land in e2e/screenshots
```

`CLAUDE.md` lists every command and the project conventions.

## Deploy

See [docs/deploy.md](docs/deploy.md) for the hosted demo (Vercel, Render and Supabase) and for self-hosting with Docker Compose.

## License

OpenPlan is licensed under the [GNU Affero General Public License v3.0](LICENSE).
