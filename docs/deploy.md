# Deploying OpenPlan

OpenPlan runs in two ways:

- **Self-hosted with Docker Compose** (the primary path): `docker compose up --build` starts the server and Postgres on http://localhost:8080.
- **Hosted demo** on free tiers: the web app and the API as one Docker web service on Render (region Singapore), and Postgres on Supabase.

The browser only talks to the Render origin, which serves both the web app and the API, so the session cookies are first-party. An optional Vercel deployment can sit in front of it (see [Vercel in front (optional)](#vercel-in-front-optional)).

## Hosted demo

### 1. Supabase (database)

1. Open the `openplan` project (region ap-south-1) and go to Project Settings → Database.
2. Reset the database password and save it somewhere safe.
3. Copy the **Session pooler** URI. Its port is 5432. The transaction pooler (port 6543) is not supported.
4. Append `?sslmode=require` to the URI. The server connects with TLS.
5. Percent-encode the password in the URI. An unencoded `#`, `?` or `/` ends the address early, which shows up as a URL parse error (for example an invalid port) or a connection to the wrong host — not as a rejected password. Percent-encode every reserved character (`: / ? # [ ] @ ! $ & ' ( ) * + , ; =`), and `%` and spaces too. For example, `@` becomes `%40`.
6. Turn off the Data API (Project Settings → Data API), or confirm it exposes nothing. OpenPlan reaches the database only through the connection string, never through the Data API. The migrations enable row level security on every table, so the Data API could not read them without a policy, but it should not be on at all.

### 2. Render (web app and API)

1. In Render, choose New → Blueprint and pick this repository. Render reads `render.yaml` and creates the `openplan-api` web service.
2. When Render asks for the variables marked `sync: false`, set:
   - `DATABASE_URL`: the URI from step 1.
   - `OPENPLAN_PUBLIC_URL`: `https://openplan-api-qmsm.onrender.com`, the Render URL itself. It must start with `https://` so cookies are marked `Secure`. If Render added a suffix to the service name, use your service's URL.
3. Check the deploy with `https://openplan-api-qmsm.onrender.com/api/health` (Render adds a suffix when the name is taken; use your service's URL). It returns `{"status":"ok",...}`.
4. Open `https://openplan-api-qmsm.onrender.com` and complete setup immediately after the first deploy. The first visitor to the setup screen becomes the instance admin, and until that happens anyone who finds the URL can take the instance.
5. In Supabase, open Advisors → Security Advisor and run it after this first deploy. It should report no `RLS Disabled in Public` errors for `users`, `sessions`, `workspaces`, `workspace_members`, `models`, `model_structure`, `line_item_data`, `change_log` or `_sqlx_migrations`.

`render.yaml` also sets `OPENPLAN_LOG=info` and `OPENPLAN_TRUSTED_PROXY_HOPS=1` (see [Trusted proxy hops](#trusted-proxy-hops)).

### Vercel in front (optional)

Use this only to serve the web app from Vercel. The Render service already serves it.

1. Import this repository as a Vercel project and set the root directory to `web`. The framework, install, build and output settings come from `web/vercel.json`.
2. `web/vercel.json` rewrites `/api/*` to `https://openplan-api-qmsm.onrender.com/api/*`. If your Render service has a different URL, change the rewrite destination to match it, then redeploy.
3. Deploy and note the Vercel domain. Then open `openplan-api` → Environment in Render, set `OPENPLAN_PUBLIC_URL` to `https://<vercel-domain>` and `OPENPLAN_TRUSTED_PROXY_HOPS` to `2`, and save. Render redeploys.

### Free-tier caveats

- Render's free web service sleeps after 15 minutes without traffic. The first request after a sleep takes about 30–60 seconds.
- Supabase's free projects pause after 7 days of inactivity. Restore a paused project from the Supabase dashboard.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string. |
| `OPENPLAN_PUBLIC_URL` | required | Public origin of the app. Cookies are marked `Secure` when it starts with `https://`. |
| `OPENPLAN_BIND` | `0.0.0.0:8080` | Address the server listens on. Takes precedence over `PORT`. |
| `PORT` | unset | Port to listen on, on all interfaces, when `OPENPLAN_BIND` is unset. Render sets it. |
| `OPENPLAN_LOG` | `info` | Log filter. |
| `OPENPLAN_TRUSTED_PROXY_HOPS` | `0` | Number of proxies in front of the server. See below. |
| `OPENPLAN_DB_POOL_SIZE` | `10` | Most database connections the server holds open. A request that finds none free waits up to 10 seconds, then fails with a 500. Keep it below your database's connection limit. |
| `OPENPLAN_MODEL_IDLE_MINUTES` | `30` | Minutes a model may go unused before it is saved as a checkpoint and unloaded from memory. Its next use loads it again. |

### Trusted proxy hops

The login rate limit counts attempts per email and client IP. Behind a proxy the peer address is the proxy's, so the server reads the client address from `X-Forwarded-For` instead, taking the entry `OPENPLAN_TRUSTED_PROXY_HOPS` positions from the right.

- **Hosted demo (Render only):** set `OPENPLAN_TRUSTED_PROXY_HOPS=1`. Render's proxy appends the address it received, so the client is the rightmost entry. Verify this after the first deploy (see the check below).
- **Hosted demo with Vercel in front:** set `OPENPLAN_TRUSTED_PROXY_HOPS=2`. This assumes Vercel replaces `X-Forwarded-For` with the client's address and Render appends the address it received from Vercel, so the client is the second entry from the right. Verify this after the first deploy (see the check below).
- **Self-hosted Docker Compose, without a proxy:** keep `0`, the default. The peer address is the client address.

A wrong value lets clients spoof their IP. If the value is higher than the number of proxies, the server trusts an entry the client supplied, and a client can change it to get a fresh login budget on every attempt. If the value is lower, or the server sits behind a proxy and the value is `0`, every client shares the proxy's address, so anyone who makes ten failed sign-ins for an account locks that account out for everyone.

**Check after the first deploy.** From one network, make 10 failed sign-ins to a test account. The 11th should return 429. Then sign in to the same account from a second network, such as a phone on mobile data. It should succeed. If the second network is refused too, the server is keying on a proxy address and the value is wrong. Change `OPENPLAN_TRUSTED_PROXY_HOPS` on Render (try `1` and `3`), repeat the check until it passes, and keep the value that passes. The check shows that separate networks get separate budgets. It does not show that the value resists spoofing. If neither value works, stop and inspect the `X-Forwarded-For` header the proxy actually forwards before trying other values.

### Limitation and per-email ceiling

Render's URL is public, so a caller can reach the API directly, without going through a Vercel deployment. Such a caller can send its own `X-Forwarded-For`, and with the hosted demo's setting the server trusts it. That lets a direct caller:

- make each request look like a new client, which gets around the per-IP limit for an email; and
- put another client's address in `X-Forwarded-For`, which uses up that client's per-IP budget for the given email (10 attempts per 15 minutes) and refuses that client's sign-ins to that account. Other addresses keep their own per-address budget, but spoofed attempts still count toward the account's shared 50-attempt ceiling.

To bound guessing, every email also has a ceiling of 50 login attempts per 15 minutes from any address. The ceiling is always on, including self-hosted Docker Compose, whatever `OPENPLAN_TRUSTED_PROXY_HOPS` is set to. It is a sliding window: each allowed attempt counts for 15 minutes, and blocked attempts are not counted. Attempts beyond the ceiling return 429, even with the correct password. Both limits live in server memory, so a restart (or a second instance) starts them from zero.

The ceiling has a cost: anyone can lock out a specific account. An attacker who keeps sending at least about 3.3 failed sign-ins a minute (50 per 15 minutes, the rate at which the window frees a slot) keeps the account locked for as long as they continue. A successful sign-in clears the counter, so each success gives an attacker a fresh 50 attempts. The ceiling therefore limits guessing to about 200 guesses per hour per account while nobody signs in successfully — each successful sign-in (including the owner's) resets the count. It does not cap the total. If an account is locked out and you cannot wait for the window to pass, restart the Render service to clear an in-memory login lock-out.

## Running one process

Run one OpenPlan process against a database. A model is loaded into the memory of the process that first uses it, and that process applies its edits in order (spec §2.3). A second process, such as a second instance or the old and the new instance while a deploy overlaps, loads its own copy of the model and edits it without knowing of the other's edits, so the two copies diverge until a model is unloaded and loaded again. Keep the Render service at one instance (the free plan has one), do not scale `openplan` in Docker Compose, and where a platform starts the new instance before it stops the old one, do not edit models while a deploy is under way.

## Self-hosting with Docker Compose

1. Install Docker with the Compose plugin.
2. From the repository root, run `docker compose up --build`.
3. Open http://localhost:8080 and complete first-run setup.

`compose.yml` sets `OPENPLAN_PUBLIC_URL=http://localhost:8080` and leaves `OPENPLAN_TRUSTED_PROXY_HOPS` at `0`. The per-email login ceiling is always on here too (see [Limitation and per-email ceiling](#limitation-and-per-email-ceiling)).
