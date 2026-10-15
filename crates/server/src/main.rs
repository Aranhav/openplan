use std::{io::Write, net::SocketAddr};

use anyhow::Context;
use clap::{Parser, Subcommand};
use openplan_server::{
    app::{AppState, build_router},
    config::Config,
    db,
    openapi::openapi_json,
};
use tracing_subscriber::EnvFilter;

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
    let filter = EnvFilter::try_new(&config.log)
        .with_context(|| format!("OPENPLAN_LOG is not a valid filter: {}", config.log))?;
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let db = db::connect(&config.database_url).await?;
    db::MIGRATOR
        .run(&db)
        .await
        .context("failed to run database migrations")?;

    let bind = config.bind;
    let app = build_router(AppState::new(db, config));
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("failed to bind {bind}"))?;
    tracing::info!(%bind, "openplan listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("server error")
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
