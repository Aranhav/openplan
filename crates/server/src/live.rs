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
//!   has to read what it shows again. What it holds then is as of the `seq` of that answer, which
//!   is where it goes on from, and not the resync's.
//!
//! It pings every 25 seconds, and closes a socket whose client has said nothing, not even a pong,
//! since the ping before the last. Every minute it checks that the user may still read the model,
//! and closes the socket with code 4403 if not, or 4404 if the model is gone. What the client
//! sends is ignored: a message of more than 16 KiB closes the socket, and so do more than 20
//! frames in 10 seconds (code 1008). A user has at most 20 tickets and 20 sockets at a time; a
//! request for more is a 429 with a `Retry-After`.

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
    authz::WorkspaceRole,
    config::{Config, origin_of},
    error::{AppError, AppResult},
    extract::{ApiPath, ApiQuery},
    structure_api::{ProdLock, handle_for},
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
/// How many tickets a user may hold that were not used or expired, and how many sockets a user
/// may have open at once. Each takes memory until it is used, expires or closes.
const MAX_TICKETS_PER_USER: usize = 20;
const MAX_SOCKETS_PER_USER: usize = 20;
/// What a user who has reached either is told to wait, in seconds: a ticket's life is a minute,
/// and a socket may close at any time.
const TICKETS_RETRY_AFTER_SECS: u64 = 60;
const SOCKETS_RETRY_AFTER_SECS: u64 = 30;
/// How many pings in a row may go without a word from the client before the socket is closed.
/// Any frame is a word: a browser answers a ping with a pong by itself.
const MAX_QUIET_PINGS: u8 = 2;
/// How many frames a client may send in a time. They are ignored, so there is no reason for more
/// than the pongs.
const MAX_CLIENT_FRAMES: u32 = 20;
const CLIENT_FRAMES_PER: Duration = Duration::from_secs(10);
/// How long the server waits for the client's side of the closing handshake, after sending its
/// close frame or before leaving, so that the client finds the code and not a connection reset.
const CLOSE_WAIT: Duration = Duration::from_secs(1);
/// The close code for a user who may no longer read the model.
const CLOSE_REMOVED: u16 = 4403;
/// The close code for a model that is gone.
const CLOSE_GONE: u16 = 4404;
/// The close code for a model that was unloaded, such as when the server restarts: the client may
/// connect again.
const CLOSE_RESTART: u16 = 1012;
/// The close code for a client that sends more than it should.
const CLOSE_POLICY: u16 = 1008;

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

/// The tickets that were issued and not yet used, by the hash of the ticket, and how many sockets
/// each user has open.
#[derive(Clone)]
pub struct Live {
    settings: LiveSettings,
    tickets: Arc<Mutex<HashMap<[u8; 32], Ticket>>>,
    sockets: Arc<Mutex<HashMap<Uuid, usize>>>,
}

/// The place of an open socket among those a user may have, given back when it is dropped.
pub struct SocketSlot {
    user_id: Uuid,
    sockets: Arc<Mutex<HashMap<Uuid, usize>>>,
}

impl Drop for SocketSlot {
    fn drop(&mut self) {
        let mut sockets = self.sockets.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(open) = sockets.get_mut(&self.user_id) {
            *open -= 1;
            if *open == 0 {
                sockets.remove(&self.user_id);
            }
        }
    }
}

fn hash(ticket: &str) -> [u8; 32] {
    Sha256::digest(ticket.as_bytes()).into()
}

impl Live {
    pub fn new(settings: LiveSettings) -> Live {
        Live {
            settings,
            tickets: Arc::new(Mutex::new(HashMap::new())),
            sockets: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn tickets(&self) -> MutexGuard<'_, HashMap<[u8; 32], Ticket>> {
        self.tickets.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A new ticket for `user_id` to open the socket of `model_id` with, unless the user holds
    /// [`MAX_TICKETS_PER_USER`] that are neither used nor expired. The tickets that have expired
    /// are dropped, so that the unused ones never pile up for longer than their life.
    fn issue(&self, user_id: Uuid, model_id: Uuid) -> AppResult<String> {
        let now = Instant::now();
        let mut tickets = self.tickets();
        tickets.retain(|_, ticket| ticket.expires_at > now);
        let held = tickets
            .values()
            .filter(|ticket| ticket.user_id == user_id)
            .count();
        if held >= MAX_TICKETS_PER_USER {
            return Err(AppError::RateLimited {
                retry_after_secs: TICKETS_RETRY_AFTER_SECS,
            });
        }
        let ticket = random_token();
        tickets.insert(
            hash(&ticket),
            Ticket {
                user_id,
                model_id,
                expires_at: now + self.settings.ticket_ttl,
            },
        );
        Ok(ticket)
    }

    /// The user a ticket was issued to, if it is for `model_id` and has not expired. A ticket is
    /// used up by being tried, whatever comes of it.
    fn redeem(&self, ticket: &str, model_id: Uuid) -> Option<Uuid> {
        let found = self.tickets().remove(&hash(ticket))?;
        (found.model_id == model_id && found.expires_at > Instant::now()).then_some(found.user_id)
    }

    /// A place for one more open socket of `user_id`, unless they have [`MAX_SOCKETS_PER_USER`].
    /// It is taken before the socket is upgraded and given back whenever the socket, or the
    /// upgrade, ends.
    fn claim(&self, user_id: Uuid) -> AppResult<SocketSlot> {
        let mut sockets = self.sockets.lock().unwrap_or_else(PoisonError::into_inner);
        let open = sockets.entry(user_id).or_default();
        if *open >= MAX_SOCKETS_PER_USER {
            return Err(AppError::RateLimited {
                retry_after_secs: SOCKETS_RETRY_AFTER_SECS,
            });
        }
        *open += 1;
        Ok(SocketSlot {
            user_id,
            sockets: Arc::clone(&self.sockets),
        })
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
        (status = 429, description = "The caller holds 20 tickets that are neither used nor expired (auth.rate_limited); `Retry-After` is 60"),
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
        ticket: state.live.issue(user.id, model_id)?,
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

/// Whether `user_id` may read `model_id` now, in one query: whether the model is there, whether
/// the user is there and not disabled, and whether they are an instance admin or a member of the
/// model's workspace, whatever their role, since every role reads.
async fn access(db: &PgPool, user_id: Uuid, model_id: Uuid) -> AppResult<Access> {
    let (model, user, reads) = sqlx::query_as::<_, (bool, bool, Option<bool>)>(
        "SELECT m.id IS NOT NULL, u.id IS NOT NULL, u.is_instance_admin OR member.user_id IS NOT NULL
         FROM (SELECT $1::uuid AS user_id, $2::uuid AS model_id) AS asked
         LEFT JOIN models m ON m.id = asked.model_id
         LEFT JOIN users u ON u.id = asked.user_id AND NOT u.disabled
         LEFT JOIN workspace_members member
                ON member.workspace_id = m.workspace_id AND member.user_id = asked.user_id",
    )
    .bind(user_id)
    .bind(model_id)
    .fetch_one(db)
    .await?;
    Ok(if !model {
        Access::ModelGone
    } else if user && reads == Some(true) {
        Access::Allowed
    } else {
        Access::Removed
    })
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
        (status = 101, description = "The connection is upgraded to a WebSocket, over which the server sends JSON text frames: `{\"type\":\"hello\",\"seq\":N}` when it opens; `{\"type\":\"cells_changed\",\"seq\":N,\"line_item_ids\":[...],\"user_id\":\"...\"}` after cells were written; `{\"type\":\"structure_changed\",\"seq\":N}` after the structure changed; and `{\"type\":\"resync\",\"seq\":N}` when the client missed changes and has to read again. It pings every 25 seconds, closes a socket that has answered neither of the last two pings, and closes with code 4403 when the user may no longer read the model, 4404 when the model is gone and 1008 when the client sends more than 20 frames in 10 seconds. What the client sends is ignored."),
        (status = 400, description = "The request is not a WebSocket upgrade"),
        (status = 403, description = "The ticket is unknown, expired, used or for another model, the Origin is not the app's, or the user may not read the model (auth.forbidden)"),
        (status = 404, description = "The model is gone (not_found)"),
        (status = 429, description = "The user has 20 sockets open (auth.rate_limited); `Retry-After` is 30"),
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
    let slot = state.live.claim(user_id)?;
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
                _slot: slot,
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
    /// Kept for as long as the socket is open.
    _slot: SocketSlot,
}

/// What a follower does next, other than waiting.
enum Step {
    Send(Message),
    /// Tell the client why the socket closes, and wait for it to answer.
    Close(u16, &'static str),
    /// The client closed: answer it, and leave.
    Answer,
    /// Leave, with nothing more to say to a client that is not there.
    Done,
}

/// How often a client sends: more than [`MAX_CLIENT_FRAMES`] in [`CLIENT_FRAMES_PER`] is too
/// often.
struct FrameRate {
    since: Instant,
    frames: u32,
}

impl FrameRate {
    fn new(now: Instant) -> FrameRate {
        FrameRate {
            since: now,
            frames: 0,
        }
    }

    /// Counts a frame received at `now`, and says whether the client sends too often.
    fn too_often(&mut self, now: Instant) -> bool {
        if now.duration_since(self.since) >= CLIENT_FRAMES_PER {
            *self = FrameRate::new(now);
        }
        self.frames += 1;
        self.frames > MAX_CLIENT_FRAMES
    }
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
        // The pings since the client was last heard from, and whether it was since the last ping.
        let mut quiet_pings = 0;
        let mut heard = false;
        let mut rate = FrameRate::new(Instant::now());
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
                    if self.send(Message::Close(Some(frame))).await {
                        self.wait_for_close().await;
                    }
                    return;
                }
                Step::Answer => {
                    self.wait_for_close().await;
                    return;
                }
                Step::Done => return,
            }
            step = loop {
                tokio::select! {
                    incoming = self.socket.recv() => match incoming {
                        Some(Ok(Message::Close(_))) => break Step::Answer,
                        Some(Err(_)) | None => break Step::Done,
                        // What else a client sends is ignored, but it shows that it is there.
                        Some(Ok(_)) => {
                            heard = true;
                            if rate.too_often(Instant::now()) {
                                break Step::Close(CLOSE_POLICY, "Too many messages.");
                            }
                        }
                    },
                    event = self.events.recv() => break self.on_event(event).await,
                    _ = ping.tick() => {
                        quiet_pings = if heard { 0 } else { quiet_pings + 1 };
                        if quiet_pings >= MAX_QUIET_PINGS {
                            break Step::Done;
                        }
                        heard = false;
                        break Step::Send(Message::Ping(Default::default()));
                    }
                    _ = recheck.tick() => {
                        if let Some(step) = self.recheck().await {
                            break step;
                        }
                    }
                }
            };
        }
    }

    /// Reads what the client sends until it has closed, or for a moment: tungstenite answers the
    /// client's close frame when it reads on, and the client finds the code we closed with and not
    /// a reset connection.
    async fn wait_for_close(&mut self) {
        let socket = &mut self.socket;
        let _ = timeout(CLOSE_WAIT, async {
            while let Some(Ok(_)) = socket.recv().await {}
        })
        .await;
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

        let first = live.issue(user, model).unwrap();
        let second = live.issue(user, model).unwrap();

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
        let ticket = live.issue(user, model).unwrap();

        assert_eq!(live.redeem(&ticket, model), Some(user));

        assert_eq!(live.redeem(&ticket, model), None);
    }

    #[test]
    fn a_ticket_for_another_model_is_used_up_by_being_tried() {
        let live = live(TICKET_TTL);
        let (user, model) = (Uuid::now_v7(), Uuid::now_v7());
        let ticket = live.issue(user, model).unwrap();

        assert_eq!(live.redeem(&ticket, Uuid::now_v7()), None);

        assert_eq!(live.redeem(&ticket, model), None);
    }

    #[test]
    fn an_expired_ticket_is_refused_and_unknown_text_is_not_a_ticket() {
        let live = live(Duration::ZERO);
        let (user, model) = (Uuid::now_v7(), Uuid::now_v7());
        let ticket = live.issue(user, model).unwrap();

        assert_eq!(live.redeem(&ticket, model), None);
        assert_eq!(live.redeem("nonsense", model), None);
        assert_eq!(live.redeem("", model), None);
    }

    #[test]
    fn expired_tickets_are_swept_when_one_is_issued() {
        let live = live(Duration::ZERO);
        let (user, model) = (Uuid::now_v7(), Uuid::now_v7());
        for _ in 0..5 {
            live.issue(user, model).unwrap();
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

    #[test]
    fn a_user_holds_20_tickets_at_most_and_the_others_are_not_held_up() {
        let live = live(TICKET_TTL);
        let (user, other, model) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        let tickets: Vec<String> = (0..20).map(|_| live.issue(user, model).unwrap()).collect();

        let refused = live.issue(user, model).unwrap_err();

        assert!(matches!(
            refused,
            AppError::RateLimited {
                retry_after_secs: 60
            }
        ));
        assert!(live.issue(other, model).is_ok());
        // One that is used makes room for one more.
        assert_eq!(live.redeem(&tickets[0], model), Some(user));
        assert!(live.issue(user, model).is_ok());
        assert!(live.issue(user, model).is_err());
    }

    #[test]
    fn tickets_that_expired_make_room_for_new_ones() {
        let live = live(Duration::ZERO);
        let (user, model) = (Uuid::now_v7(), Uuid::now_v7());

        for _ in 0..50 {
            live.issue(user, model).unwrap();
        }
    }

    #[test]
    fn a_user_has_20_sockets_open_at_most_and_a_closed_one_makes_room() {
        let live = live(TICKET_TTL);
        let (user, other) = (Uuid::now_v7(), Uuid::now_v7());
        let mut slots: Vec<SocketSlot> = (0..20).map(|_| live.claim(user).unwrap()).collect();

        let refused = live.claim(user).err().unwrap();

        assert!(matches!(
            refused,
            AppError::RateLimited {
                retry_after_secs: 30
            }
        ));
        assert!(live.claim(other).is_ok());
        slots.pop();
        let again = live.claim(user);
        assert!(again.is_ok());
        assert!(live.claim(user).is_err());
        // Dropping the slots leaves nothing counted.
        drop(again);
        slots.clear();
        assert!(live.sockets.lock().unwrap().is_empty());
    }

    #[test]
    fn a_client_may_send_20_frames_in_10_seconds_and_no_more() {
        let start = Instant::now();
        let mut rate = FrameRate::new(start);

        assert!((0..20).all(|_| !rate.too_often(start)));
        assert!(rate.too_often(start + Duration::from_secs(9)));

        // Ten seconds on, the count starts again.
        let mut rate = FrameRate::new(start);
        assert!((0..20).all(|_| !rate.too_often(start)));
        assert!(!rate.too_often(start + Duration::from_secs(10)));
        assert!((1..20).all(|_| !rate.too_often(start + Duration::from_secs(10))));
        assert!(rate.too_often(start + Duration::from_secs(11)));
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
