# syntax=docker/dockerfile:1
# Build context is the repository root: docker build -f docker/Dockerfile .

FROM node:22-bookworm-slim AS web
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
# The lockfile covers every workspace package, so each one's manifest has to be present.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile --filter "web..."
COPY web web
RUN pnpm --dir web build

FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates crates
# The server embeds the web app at compile time.
COPY --from=web /app/web/dist web/dist
RUN cargo build --release --locked -p openplan-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin openplan
COPY --from=build /app/target/release/openplan /usr/local/bin/openplan
USER openplan
EXPOSE 8080
CMD ["openplan", "serve"]
