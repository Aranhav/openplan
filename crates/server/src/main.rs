use std::{io::Write, net::SocketAddr};

use anyhow::Context;
use clap::{Parser, Subcommand};
use openplan_server::{
    actor,
    app::{AppState, build_router},
    auth::session,
    config::Config,
    db, logging,
    openapi::openapi_json,
};

#[derive(Parser)]
#[command(name = "openplan", version, about = "OpenPlan planning platform")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP server (default)
    Serve,
    /// Print the OpenAPI document as JSON
    Openapi,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command.unwrap_or(Command::Serve) {
        Command::Serve => serve().await,
        Command::Openapi => {
            writeln!(std::io::stdout().lock(), "{}", openapi_json())?;
            Ok(())
        }
    }
}

async fn serve() -> anyhow::Result<()> {
    let config = Config::from_env()?;
    logging::init(&config.log)?;
    if config.public_origin().is_none() {
        tracing::warn!(
            public_url = %config.public_url,
            "OPENPLAN_PUBLIC_URL is not an http or https address, so live sockets are not checked for their Origin"
        );
    }

    let db = db::connect(&config.database_url, config.db_pool_size).await?;
    db::MIGRATOR
        .run(&db)
        .await
        .context("failed to run database migrations")?;

    tokio::spawn(session::purge_expired_periodically(db.clone()));

    let bind = config.bind;
    let state = AppState::new(db, config);
    let models = state.models.clone();
    tokio::spawn(actor::evict_idle_periodically(models.clone()));
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("failed to bind {bind}"))?;
    tracing::info!(%bind, "openplan listening");
    let served = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("server error");
    models.shutdown().await;
    served
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
