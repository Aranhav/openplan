//! Live updates of the grid of a model over a WebSocket.
//!
//! A browser cannot always send its session cookie to the WebSocket: when the web app is served
//! from another host than the API, as it is behind Vercel, which does not proxy WebSockets, the
//! cookie belongs to the other host. So the socket is opened with a ticket instead. The browser
//! asks for one with its session (`POST /models/{id}/live/ticket`, which is CSRF protected like
//! any other post) and opens the socket at the address that comes with it. A ticket is 32 random
//! bytes, kept only as a hash, good for one use on one model for a minute.
//!
//! Once opened, the server tells the client about the model, one JSON text frame at a time:
//!
//! - `{"type":"hello","seq":N}` when it opens, with the sequence number of the last change in the
//!   model at that time. A change that was made just before may be told of after it all the same,
//!   so a client keeps the highest `seq` it has seen and ignores a change at or below it;
//! - `{"type":"cells_changed","seq":N,"line_item_ids":[..],"user_id":".."}` after cells were
//!   written, with the line items whose cells changed and the user who wrote them;
//! - `{"type":"structure_changed","seq":N}` after lists, time, versions, modules or line items
//!   changed;
//! - `{"type":"resync","seq":N}` when the client fell so far behind that it missed changes, and
//!   has to read what it shows again.
//!
//! It pings every 25 seconds. Every minute it checks that the user may still read the model, and
//! closes the socket with code 4403 if not, or 4404 if the model is gone. What the client sends
//! is ignored, and a message of more than 16 KiB closes the socket.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{
        State,
        ws::{
            CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade,
            rejection::WebSocketUpgradeRejection,
        },
    },
    http::{HeaderMap, header},
    response::Response,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::{
    sync::broadcast::{self, error::RecvError},
    time::{Instant, MissedTickBehavior, interval_at, timeout},
};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    actor::{ModelEvent, ModelHandle},
    app::AppState,
    auth::{CurrentUser, random_token},
    authz::{WorkspaceRole, workspace_role},
    config::{Config, origin_of},
    error::{AppError, AppResult},
    extract::{ApiPath, ApiQuery},
    structure_api::{ProdLock, handle_for, model_row},
};

/// How long a ticket can be used for.
const TICKET_TTL: Duration = Duration::from_secs(60);
/// How often the server pings a socket.
const PING_EVERY: Duration = Duration::from_secs(25);
/// How often the server checks that a socket's user may still read the model.
const RECHECK_EVERY: Duration = Duration::from_secs(60);
/// How long a send to a client may take before it is given up on. A client that does not read
/// would otherwise keep the socket and what it holds for ever.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// How large a message from a client may be. They are ignored, so there is no reason to hold a
/// large one.
const MAX_CLIENT_MESSAGE: usize = 16 << 10;
/// The close code for a user who may no longer read the model.
const CLOSE_REMOVED: u16 = 4403;
/// The close code for a model that is gone.
const CLOSE_GONE: u16 = 4404;
/// The close code for a model that was unloaded, such as when the server restarts: the client may
/// connect again.
const CLOSE_RESTART: u16 = 1012;

/// The times that govern the sockets. They are those of the server's own, apart from in tests,
/// which make them short.
#[derive(Clone, Copy, Debug)]
pub struct LiveSettings {
    pub ticket_ttl: Duration,
    pub ping_every: Duration,
    pub recheck_every: Duration,
}

impl Default for LiveSettings {
    fn default() -> Self {
        LiveSettings {
            ticket_ttl: TICKET_TTL,
            ping_every: PING_EVERY,
            recheck_every: RECHECK_EVERY,
        }
    }
}

struct Ticket {
    user_id: Uuid,
    model_id: Uuid,
    expires_at: Instant,
}

/// The tickets that were issued and not yet used, by the hash of the ticket.
#[derive(Clone)]
pub struct Live {
    settings: LiveSettings,
    tickets: Arc<Mutex<HashMap<[u8; 32], Ticket>>>,
}

fn hash(ticket: &str) -> [u8; 32] {
    Sha256::digest(ticket.as_bytes()).into()
}

impl Live {
    pub fn new(settings: LiveSettings) -> Live {
        Live {
            settings,
            tickets: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn tickets(&self) -> MutexGuard<'_, HashMap<[u8; 32], Ticket>> {
        self.tickets.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A new ticket for `user_id` to open the socket of `model_id` with. The tickets that have
    /// expired are dropped, so that the unused ones never pile up for longer than their life.
    fn issue(&self, user_id: Uuid, model_id: Uuid) -> String {
        let ticket = random_token();
        let now = Instant::now();
        let mut tickets = self.tickets();
        tickets.retain(|_, ticket| ticket.expires_at > now);
        tickets.insert(
            hash(&ticket),
            Ticket {
                user_id,
                model_id,
                expires_at: now + self.settings.ticket_ttl,
            },
        );
        ticket
    }

    /// The user a ticket was issued to, if it is for `model_id` and has not expired. A ticket is
    /// used up by being tried, whatever comes of it.
    fn redeem(&self, ticket: &str, model_id: Uuid) -> Option<Uuid> {
        let found = self.tickets().remove(&hash(ticket))?;
        (found.model_id == model_id && found.expires_at > Instant::now()).then_some(found.user_id)
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/models/{id}/live/ticket", post(create_ticket))
        .route("/models/{id}/live", get(connect))
}

/// Where to open the socket of a model, and the ticket to open it with.
#[derive(Serialize, ToSchema)]
pub struct LiveTicketResponse {
    /// Good for one use, within a minute.
    ticket: String,
    /// The address of the socket, to which `?ticket=` and the ticket are added.
    url: String,
}

/// Where browsers open sockets: the configured live address, or else the host that the request
/// came to, secure if a proxy says that the request came in over https.
fn live_base(config: &Config, headers: &HeaderMap) -> String {
    config.live_url.clone().unwrap_or_else(|| {
        let text = |name: header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok());
        let host = text(header::HOST).unwrap_or("localhost");
        let secure = text(header::HeaderName::from_static("x-forwarded-proto"))
            .is_some_and(|proto| proto.eq_ignore_ascii_case("https"));
        format!("{}://{host}", if secure { "wss" } else { "ws" })
    })
}

#[utoipa::path(
    post,
    path = "/api/v1/models/{id}/live/ticket",
    tag = "live",
    params(("id" = Uuid, Path, description = "The model's id")),
    responses(
        (status = 200, description = "A ticket to open the live socket of the model with", body = LiveTicketResponse),
        (status = 401, description = "Not signed in (auth.unauthenticated)"),
        (status = 404, description = "No such model, or the caller is not a member of its workspace (not_found)"),
    )
)]
pub(crate) async fn create_ticket(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiPath(model_id): ApiPath<Uuid>,
    headers: HeaderMap,
) -> AppResult<Json<LiveTicketResponse>> {
    handle_for(
        &state,
        &user,
        model_id,
        WorkspaceRole::Viewer,
        ProdLock::Ignore,
    )
    .await?;
    let base = live_base(&state.config, &headers);
    Ok(Json(LiveTicketResponse {
        ticket: state.live.issue(user.id, model_id),
        url: format!("{base}/api/v1/models/{model_id}/live"),
    }))
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TicketQuery {
    /// The ticket from `POST /models/{id}/live/ticket`.
    ticket: String,
}

/// What the server tells a client.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Outgoing {
    Hello {
        seq: i64,
    },
    CellsChanged {
        seq: i64,
        line_item_ids: Vec<Uuid>,
        user_id: Uuid,
    },
    StructureChanged {
        seq: i64,
    },
    Resync {
        seq: i64,
    },
}

impl From<ModelEvent> for Outgoing {
    fn from(event: ModelEvent) -> Self {
        match event {
            ModelEvent::CellsChanged {
                seq,
                line_item_ids,
                user_id,
            } => Outgoing::CellsChanged {
                seq,
                line_item_ids: line_item_ids.into_iter().map(|id| id.0).collect(),
                user_id,
            },
            ModelEvent::StructureChanged { seq } => Outgoing::StructureChanged { seq },
        }
    }
}

impl Outgoing {
    fn frame(&self) -> Message {
        let json = serde_json::to_string(self).expect("a message serializes to JSON");
        Message::Text(Utf8Bytes::from(json))
    }
}

/// What a follower is told for what its subscription gave it: the change, or, if it missed some,
/// that it has to read again, with the sequence number `current` gives. Nothing when the channel
/// is closed, which is not for the client to be told.
fn told_of(
    event: Result<ModelEvent, RecvError>,
    current: impl FnOnce() -> i64,
) -> Option<Outgoing> {
    match event {
        Ok(event) => Some(Outgoing::from(event)),
        Err(RecvError::Lagged(_)) => Some(Outgoing::Resync { seq: current() }),
        Err(RecvError::Closed) => None,
    }
}

/// Whether a user may read a model.
#[derive(Debug, PartialEq)]
enum Access {
    Allowed,
    /// The user is not a member of the model's workspace any more, or is disabled or gone.
    Removed,
    ModelGone,
}

/// Whether `user_id` may read `model_id` now.
async fn access(db: &PgPool, user_id: Uuid, model_id: Uuid) -> AppResult<Access> {
    let workspace_id = match model_row(db, model_id).await {
        Ok((workspace_id, _)) => workspace_id,
        Err(AppError::NotFound) => return Ok(Access::ModelGone),
        Err(error) => return Err(error),
    };
    let user = sqlx::query_as::<_, CurrentUser>(
        "SELECT id, email, name, is_instance_admin FROM users WHERE id = $1 AND NOT disabled",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let Some(user) = user else {
        return Ok(Access::Removed);
    };
    match workspace_role(db, &user, workspace_id).await {
        Ok(_) => Ok(Access::Allowed),
        Err(AppError::NotFound) => Ok(Access::Removed),
        Err(error) => Err(error),
    }
}

/// Whether a browser at `origin` may open sockets: one that says where it comes from has to come
/// from the app. A request without an origin is not from a browser page.
fn origin_allowed(config: &Config, origin: Option<&header::HeaderValue>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some(public) = config.public_origin() else {
        return true;
    };
    origin
        .to_str()
        .ok()
        .and_then(origin_of)
        .is_some_and(|origin| origin == public)
}

#[utoipa::path(
    get,
    path = "/api/v1/models/{id}/live",
    tag = "live",
    params(("id" = Uuid, Path, description = "The model's id"), TicketQuery),
    responses(
        (status = 101, description = "The connection is upgraded to a WebSocket, over which the server sends JSON text frames: `{\"type\":\"hello\",\"seq\":N}` when it opens; `{\"type\":\"cells_changed\",\"seq\":N,\"line_item_ids\":[...],\"user_id\":\"...\"}` after cells were written; `{\"type\":\"structure_changed\",\"seq\":N}` after the structure changed; and `{\"type\":\"resync\",\"seq\":N}` when the client missed changes and has to read again. It pings every 25 seconds and closes with code 4403 when the user may no longer read the model and 4404 when the model is gone. What the client sends is ignored."),
        (status = 400, description = "The request is not a WebSocket upgrade"),
        (status = 403, description = "The ticket is unknown, expired, used or for another model, the Origin is not the app's, or the user may not read the model (auth.forbidden)"),
        (status = 404, description = "The model is gone (not_found)"),
    )
)]
pub(crate) async fn connect(
    State(state): State<AppState>,
    ApiPath(model_id): ApiPath<Uuid>,
    ApiQuery(query): ApiQuery<TicketQuery>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> AppResult<Response> {
    let Ok(upgrade) = upgrade else {
        return Err(AppError::BadRequest(
            "Open this address as a WebSocket.".to_string(),
        ));
    };
    if !origin_allowed(&state.config, headers.get(header::ORIGIN)) {
        return Err(AppError::Forbidden);
    }
    let user_id = state
        .live
        .redeem(&query.ticket, model_id)
        .ok_or(AppError::Forbidden)?;
    match access(&state.db, user_id, model_id).await? {
        Access::Allowed => {}
        Access::Removed => return Err(AppError::Forbidden),
        Access::ModelGone => return Err(AppError::NotFound),
    }
    let handle = state.models.get(model_id).await?;
    // Subscribing comes first, so that no change falls between what hello says and the events.
    let events = handle.subscribe();
    let (_, seq) = handle.snapshot_seq();
    Ok(upgrade
        .max_message_size(MAX_CLIENT_MESSAGE)
        .max_frame_size(MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| {
            Follower {
                socket,
                state,
                model_id,
                user_id,
                handle,
                events,
            }
            .follow(seq)
        }))
}

/// A socket and what it follows.
struct Follower {
    socket: WebSocket,
    state: AppState,
    model_id: Uuid,
    user_id: Uuid,
    handle: ModelHandle,
    events: broadcast::Receiver<ModelEvent>,
}

/// What a follower does next, other than waiting.
enum Step {
    Send(Message),
    Close(u16, &'static str),
    Done,
}

impl Follower {
    /// Tells the client about the model until it goes away or the user may not read it any more.
    async fn follow(mut self, seq: i64) {
        let settings = self.state.live.settings;
        let mut ping = interval_at(Instant::now() + settings.ping_every, settings.ping_every);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut recheck = interval_at(
            Instant::now() + settings.recheck_every,
            settings.recheck_every,
        );
        recheck.set_missed_tick_behavior(MissedTickBehavior::Delay);

        let mut step = Step::Send(Outgoing::Hello { seq }.frame());
        loop {
            match step {
                Step::Send(message) => {
                    if !self.send(message).await {
                        return;
                    }
                }
                Step::Close(code, reason) => {
                    let frame = CloseFrame {
                        code,
                        reason: Utf8Bytes::from_static(reason),
                    };
                    self.send(Message::Close(Some(frame))).await;
                    return;
                }
                Step::Done => return,
            }
            step = loop {
                tokio::select! {
                    incoming = self.socket.recv() => match incoming {
                        // What a client sends is ignored, but for its closing.
                        Some(Ok(Message::Close(_)) | Err(_)) | None => break Step::Done,
                        Some(Ok(_)) => {}
                    },
                    event = self.events.recv() => break self.on_event(event).await,
                    _ = ping.tick() => break Step::Send(Message::Ping(Default::default())),
                    _ = recheck.tick() => {
                        if let Some(step) = self.recheck().await {
                            break step;
                        }
                    }
                }
            };
        }
    }

    async fn send(&mut self, message: Message) -> bool {
        matches!(
            timeout(SEND_TIMEOUT, self.socket.send(message)).await,
            Ok(Ok(()))
        )
    }

    async fn on_event(&mut self, event: Result<ModelEvent, RecvError>) -> Step {
        let handle = &self.handle;
        match told_of(event, || handle.snapshot_seq().1) {
            Some(message) => Step::Send(message.frame()),
            // The actor stopped: the model was deleted, or unloaded, as it is when the server
            // stops.
            None => match self.recheck().await {
                Some(step) => step,
                None => Step::Close(CLOSE_RESTART, "The model was unloaded."),
            },
        }
    }

    /// Closes the socket if its user may not read the model any more, or the model is gone.
    async fn recheck(&mut self) -> Option<Step> {
        match access(&self.state.db, self.user_id, self.model_id).await {
            Ok(Access::Allowed) => None,
            Ok(Access::Removed) => Some(Step::Close(
                CLOSE_REMOVED,
                "You can no longer read this model.",
            )),
            Ok(Access::ModelGone) => Some(Step::Close(CLOSE_GONE, "This model was deleted.")),
            Err(error) => {
                tracing::warn!(%error, "failed to check who follows a model");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

    use super::*;

    fn live(ttl: Duration) -> Live {
        Live::new(LiveSettings {
            ticket_ttl: ttl,
            ..LiveSettings::default()
        })
    }

    #[test]
    fn a_ticket_is_32_random_bytes_and_only_its_hash_is_kept() {
        let live = live(TICKET_TTL);
        let (user, model) = (Uuid::now_v7(), Uuid::now_v7());

        let first = live.issue(user, model);
        let second = live.issue(user, model);

        assert_ne!(first, second);
        assert_eq!(first.len(), 43);
        assert_eq!(URL_SAFE_NO_PAD.decode(&first).unwrap().len(), 32);
        let tickets = live.tickets();
        assert_eq!(tickets.len(), 2);
        assert!(tickets.contains_key(&hash(&first)));
    }

    #[test]
    fn a_ticket_works_once_for_its_user_and_model() {
        let live = live(TICKET_TTL);
        let (user, model) = (Uuid::now_v7(), Uuid::now_v7());
        let ticket = live.issue(user, model);

        assert_eq!(live.redeem(&ticket, model), Some(user));

        assert_eq!(live.redeem(&ticket, model), None);
    }

    #[test]
    fn a_ticket_for_another_model_is_used_up_by_being_tried() {
        let live = live(TICKET_TTL);
        let (user, model) = (Uuid::now_v7(), Uuid::now_v7());
        let ticket = live.issue(user, model);

        assert_eq!(live.redeem(&ticket, Uuid::now_v7()), None);

        assert_eq!(live.redeem(&ticket, model), None);
    }

    #[test]
    fn an_expired_ticket_is_refused_and_unknown_text_is_not_a_ticket() {
        let live = live(Duration::ZERO);
        let (user, model) = (Uuid::now_v7(), Uuid::now_v7());
        let ticket = live.issue(user, model);

        assert_eq!(live.redeem(&ticket, model), None);
        assert_eq!(live.redeem("nonsense", model), None);
        assert_eq!(live.redeem("", model), None);
    }

    #[test]
    fn expired_tickets_are_swept_when_one_is_issued() {
        let live = live(Duration::ZERO);
        let (user, model) = (Uuid::now_v7(), Uuid::now_v7());
        for _ in 0..5 {
            live.issue(user, model);
        }

        // Each issue sweeps those before it, so only the last is left.
        assert_eq!(live.tickets().len(), 1);
    }

    #[test]
    fn messages_are_written_as_the_clients_read_them() {
        let user = Uuid::nil();
        let line_item = Uuid::nil();
        let cases = [
            (
                Outgoing::Hello { seq: 4 },
                serde_json::json!({ "type": "hello", "seq": 4 }),
            ),
            (
                Outgoing::CellsChanged {
                    seq: 5,
                    line_item_ids: vec![line_item],
                    user_id: user,
                },
                serde_json::json!({
                    "type": "cells_changed",
                    "seq": 5,
                    "line_item_ids": [line_item],
                    "user_id": user,
                }),
            ),
            (
                Outgoing::StructureChanged { seq: 6 },
                serde_json::json!({ "type": "structure_changed", "seq": 6 }),
            ),
            (
                Outgoing::Resync { seq: 7 },
                serde_json::json!({ "type": "resync", "seq": 7 }),
            ),
        ];
        for (message, json) in cases {
            assert_eq!(serde_json::to_value(&message).unwrap(), json);
        }
    }

    #[test]
    fn an_event_becomes_the_message_that_tells_of_it() {
        let user = Uuid::now_v7();
        let line_item = openplan_engine::LineItemId::new();

        assert_eq!(
            Outgoing::from(ModelEvent::CellsChanged {
                seq: 9,
                line_item_ids: vec![line_item],
                user_id: user,
            }),
            Outgoing::CellsChanged {
                seq: 9,
                line_item_ids: vec![line_item.0],
                user_id: user,
            }
        );
        assert_eq!(
            Outgoing::from(ModelEvent::StructureChanged { seq: 10 }),
            Outgoing::StructureChanged { seq: 10 }
        );
    }

    #[test]
    fn a_follower_that_missed_changes_is_told_to_read_again_from_the_current_state() {
        let missed = told_of(Err(RecvError::Lagged(1_500)), || 42);
        assert_eq!(missed, Some(Outgoing::Resync { seq: 42 }));

        let change = told_of(Ok(ModelEvent::StructureChanged { seq: 7 }), || {
            unreachable!("a change is told as it is")
        });
        assert_eq!(change, Some(Outgoing::StructureChanged { seq: 7 }));

        assert_eq!(told_of(Err(RecvError::Closed), || 42), None);
    }

    fn config(public_url: &str) -> Config {
        Config::from_lookup(|name| match name {
            "DATABASE_URL" => Some("postgres://invalid".to_string()),
            "OPENPLAN_PUBLIC_URL" => Some(public_url.to_string()),
            _ => None,
        })
        .unwrap()
    }

    fn allowed(config: &Config, origin: Option<&str>) -> bool {
        let origin = origin.map(|origin| header::HeaderValue::from_str(origin).unwrap());
        origin_allowed(config, origin.as_ref())
    }

    #[test]
    fn only_the_origin_of_the_app_may_open_a_socket() {
        let config = config("https://plan.acme.com/");

        assert!(allowed(&config, None));
        assert!(allowed(&config, Some("https://plan.acme.com")));
        assert!(allowed(&config, Some("https://PLAN.acme.com:443")));
        assert!(!allowed(&config, Some("https://evil.example")));
        assert!(!allowed(&config, Some("http://plan.acme.com")));
        assert!(!allowed(&config, Some("https://plan.acme.com:8443")));
        assert!(!allowed(
            &config,
            Some("https://plan.acme.com.evil.example")
        ));
        assert!(!allowed(&config, Some("null")));
        assert!(!allowed(&config, Some("")));
    }

    #[test]
    fn a_public_url_that_is_no_web_address_has_no_origin_to_check() {
        assert!(allowed(
            &config("plan.acme.com"),
            Some("https://evil.example")
        ));
    }

    #[test]
    fn the_socket_is_at_the_live_url_or_else_the_host_of_the_request() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "internal:8080".parse().unwrap());

        assert_eq!(
            live_base(&config("https://plan.acme.com"), &headers),
            "wss://plan.acme.com"
        );
        assert_eq!(
            live_base(&config("plan.acme.com"), &headers),
            "ws://internal:8080"
        );
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(
            live_base(&config("plan.acme.com"), &headers),
            "wss://internal:8080"
        );
    }
}
