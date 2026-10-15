# Deploying OpenPlan

OpenPlan runs in two ways:

- **Self-hosted with Docker Compose** (the primary path): `docker compose up --build` starts the server and Postgres on http://localhost:8080.
- **Hosted demo** on free tiers: the web app on Vercel, the API as a Docker web service on Render (region Singapore), and Postgres on Supabase.

The browser only talks to the Vercel origin. Vercel rewrites `/api/*` to the Render service, so the session cookies stay first-party.

## Hosted demo

### 1. Supabase (database)

1. Open the `openplan` project (region ap-south-1) and go to Project Settings → Database.
2. Reset the database password and save it somewhere safe.
3. Copy the **Session pooler** URI. Its port is 5432. The transaction pooler (port 6543) is not supported.
4. Append `?sslmode=require` to the URI. The server connects with TLS.

### 2. Render (API)

1. In Render, choose New → Blueprint and pick this repository. Render reads `render.yaml` and creates the `openplan-api` web service.
2. When Render asks for the variables marked `sync: false`, set:
   - `DATABASE_URL`: the URI from step 1.
   - `OPENPLAN_PUBLIC_URL`: `https://<vercel-domain>`, the domain from step 3. If you do not have it yet, set it after step 3 and let Render redeploy.
3. Check the deploy with `https://openplan-api.onrender.com/api/health`. It returns `{"status":"ok",...}`.

`render.yaml` also sets `OPENPLAN_LOG=info` and `OPENPLAN_TRUSTED_PROXY_HOPS=2` (see [Trusted proxy hops](#trusted-proxy-hops)).

### 3. Vercel (web)

1. Import this repository as a Vercel project and set the root directory to `web`. The framework, install, build and output settings come from `web/vercel.json`.
2. `web/vercel.json` rewrites `/api/*` to `https://openplan-api.onrender.com/api/*`. If your Render service has a different URL, change the rewrite destination to match it, then redeploy.
3. Deploy and note the Vercel domain for `OPENPLAN_PUBLIC_URL` in step 2.

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

### Trusted proxy hops

The login rate limit counts attempts per email and client IP. Behind a proxy the peer address is the proxy's, so the server reads the client address from `X-Forwarded-For` instead. Each proxy appends the address it received, so the client is the entry `OPENPLAN_TRUSTED_PROXY_HOPS` positions from the right.

- **Hosted demo:** set `OPENPLAN_TRUSTED_PROXY_HOPS=2`. The browser reaches the server through two proxies, Vercel's rewrite and Render's load balancer.
- **Self-hosted Docker Compose, without a proxy:** keep `0`, the default. The peer address is the client address.

A wrong value lets clients spoof their IP. If the value is higher than the number of proxies, the server trusts an entry the client supplied, and a client can change it to get a fresh login budget on every attempt. If the value is lower, or the server sits behind a proxy and the value is `0`, every client shares the proxy's address, so anyone who makes ten failed sign-ins for an account locks that account out for everyone.

## Self-hosting with Docker Compose

1. Install Docker with the Compose plugin.
2. From the repository root, run `docker compose up --build`.
3. Open http://localhost:8080 and complete first-run setup.

`compose.yml` sets `OPENPLAN_PUBLIC_URL=http://localhost:8080` and leaves `OPENPLAN_TRUSTED_PROXY_HOPS` at `0`.
