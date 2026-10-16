mod common;

use std::{collections::BTreeSet, net::SocketAddr, time::Duration};

use axum::http::{Method, StatusCode};
use common::{
    TestApp, TestResponse, assert_problem, create_items, create_line_item, create_list,
    create_member, create_model, create_module, create_user, id_of, list_axis, plan, plan_in,
    sign_in_beside, url,
};
use futures_util::{SinkExt, StreamExt};
use openplan_server::{actor::ModelRegistry, auth::SESSION_COOKIE, live::LiveSettings};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::{
    net::{TcpSocket, TcpStream},
    time::timeout,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, client_async, connect_async,
    tungstenite::{self, Message, client::IntoClientRequest},
};
use uuid::Uuid;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How long a test waits for the server to say something.
const WAIT: Duration = Duration::from_secs(5);

/// Opens the socket of a model with a ticket and the `Origin` header of a browser, if any.
async fn open(
    address: SocketAddr,
    model: &str,
    ticket: &str,
    origin: Option<&str>,
) -> Result<Socket, tungstenite::Error> {
    let mut request = format!("ws://{address}/api/v1/models/{model}/live?ticket={ticket}")
        .into_client_request()
        .unwrap();
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
    }
    connect_async(request).await.map(|(socket, _)| socket)
}

/// The status, the problem and the `Retry-After` of a socket that was refused before it was
/// opened.
fn refusal_with_retry(
    result: Result<Socket, tungstenite::Error>,
) -> (StatusCode, Value, Option<String>) {
    match result {
        Err(tungstenite::Error::Http(response)) => {
            let content_type = response.headers()["content-type"].to_str().unwrap();
            assert!(
                content_type.starts_with("application/problem+json"),
                "{content_type}"
            );
            let retry = response
                .headers()
                .get("retry-after")
                .map(|value| value.to_str().unwrap().to_string());
            let body = response.body().as_deref().unwrap_or_default();
            (
                StatusCode::from_u16(response.status().as_u16()).unwrap(),
                serde_json::from_slice(body).unwrap(),
                retry,
            )
        }
        Err(other) => panic!("expected a refusal, got {other}"),
        Ok(_) => panic!("expected a refusal, got a socket"),
    }
}

/// The status and the problem of a socket that was refused before it was opened.
fn refusal(result: Result<Socket, tungstenite::Error>) -> (StatusCode, Value) {
    let (status, problem, _) = refusal_with_retry(result);
    (status, problem)
}

async fn ticket_response(app: &mut TestApp, model: &str) -> TestResponse {
    app.post(&url(model, "/live/ticket"), None).await
}

async fn ticket(app: &mut TestApp, model: &str) -> String {
    let response = ticket_response(app, model).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json["ticket"].as_str().unwrap().to_string()
}

/// A socket of the model for the signed-in user, past its hello, and the seq it said.
async fn follow(address: SocketAddr, app: &mut TestApp, model: &str) -> (Socket, i64) {
    let ticket = ticket(app, model).await;
    let mut socket = open(address, model, &ticket, None).await.unwrap();
    let hello = next_json(&mut socket).await;
    assert_eq!(hello["type"], "hello");
    (socket, hello["seq"].as_i64().unwrap())
}

/// The next message the server sends as JSON, skipping pings.
async fn next_json(socket: &mut Socket) -> Value {
    loop {
        let message = timeout(WAIT, socket.next())
            .await
            .expect("the server says something in time")
            .expect("the socket stays open")
            .expect("the socket has no error");
        match message {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(_) | Message::Pong(_) => {}
            other => panic!("expected a JSON message, got {other:?}"),
        }
    }
}

/// The code that the server closes the socket with, skipping what it sends before.
async fn closed_with(socket: &mut Socket) -> u16 {
    loop {
        let message = timeout(WAIT, socket.next())
            .await
            .expect("the server closes the socket in time")
            .expect("the server says why it closes")
            .expect("the socket has no error");
        if let Message::Close(frame) = message {
            return frame.expect("a close frame with a code").code.into();
        }
    }
}

/// Whether nothing, but pings, arrives within a moment.
async fn quiet(socket: &mut Socket) -> bool {
    loop {
        match timeout(Duration::from_millis(300), socket.next()).await {
            Err(_) => return true,
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
            Ok(_) => return false,
        }
    }
}

/// Whether the socket is still open, with nothing but pings, after `time` of reading it.
async fn stays_open(socket: &mut Socket, time: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + time;
    loop {
        match tokio::time::timeout_at(deadline, socket.next()).await {
            Err(_) => return true,
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
            Ok(_) => return false,
        }
    }
}

/// Lists Products over a module with the input Units and Double, which is twice Units.
struct Counts {
    widget: String,
    units: String,
    double: String,
}

async fn counts(app: &mut TestApp, model: &str) -> Counts {
    let products = create_list(app, model, json!({ "name": "Products" })).await;
    let items = create_items(app, model, &products, json!([{ "name": "Widget" }])).await;
    let module = create_module(app, model, "Counts", vec![list_axis(&products)]).await;
    let units = id_of(&create_line_item(app, model, &module, json!({ "name": "Units" })).await);
    let double = id_of(
        &create_line_item(
            app,
            model,
            &module,
            json!({ "name": "Double", "formula": "Units * 2" }),
        )
        .await,
    );
    Counts {
        widget: id_of(&items[0]),
        units,
        double,
    }
}

/// Writes a number into Units for the widget and returns the seq of the change.
async fn write(app: &mut TestApp, model: &str, counts: &Counts, value: f64) -> i64 {
    let response = app
        .post(
            &url(model, "/cells"),
            Some(json!({ "edits": [{
                "line_item_id": counts.units,
                "coords": [counts.widget],
                "value": { "t": "number", "v": value },
            }] })),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json["seq"].as_i64().unwrap()
}

fn short(ping_every: u64, recheck_every: u64) -> LiveSettings {
    LiveSettings {
        ping_every: Duration::from_millis(ping_every),
        recheck_every: Duration::from_millis(recheck_every),
        ..LiveSettings::default()
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn ticket_requires_csrf_and_membership(pool: PgPool) {
    let (mut admin, workspace, id) = plan(&pool).await;
    create_member(&mut admin, &workspace, "vera@acme.com", "Vera", "viewer").await;
    create_user(&mut admin, "olga@acme.com", "Olga Outsider").await;
    let mut viewer = sign_in_beside(&admin, "vera@acme.com").await;
    let mut outsider = sign_in_beside(&admin, "olga@acme.com").await;
    let mut anonymous = admin.fork();
    anonymous.forget_cookie(SESSION_COOKIE);
    let unknown = Uuid::now_v7().to_string();

    let unprotected = admin
        .request_without_csrf(Method::POST, &url(&id, "/live/ticket"), None)
        .await;
    assert_problem(&unprotected, StatusCode::FORBIDDEN, "auth.csrf");
    let unsigned = ticket_response(&mut anonymous, &id).await;
    assert_problem(&unsigned, StatusCode::UNAUTHORIZED, "auth.unauthenticated");
    let refused = ticket_response(&mut outsider, &id).await;
    assert_problem(&refused, StatusCode::NOT_FOUND, "not_found");
    let gone = ticket_response(&mut admin, &unknown).await;
    assert_problem(&gone, StatusCode::NOT_FOUND, "not_found");

    // A viewer may follow the model. Tickets are all different and 43 characters of base64url.
    let first = ticket_response(&mut viewer, &id).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text);
    let second = ticket_response(&mut viewer, &id).await;
    let ticket = first.json["ticket"].as_str().unwrap();
    assert_eq!(ticket.len(), 43);
    assert!(
        ticket
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    );
    assert_ne!(first.json["ticket"], second.json["ticket"]);
    // The address is that of the socket on the server's own origin, since nothing else is set.
    assert_eq!(
        first.json["url"],
        format!("ws://localhost:8080/api/v1/models/{id}/live")
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn ws_hello_then_cells_changed_after_edit(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let counts = counts(&mut admin, &id).await;
    let before = write(&mut admin, &id, &counts, 1.0).await;
    let me = admin.get("/api/v1/auth/me").await;
    let user_id = me.json["user"]["id"].as_str().unwrap().to_string();
    let address = admin.serve().await;

    let (mut socket, hello_seq) = follow(address, &mut admin, &id).await;

    // The hello says where the model was when the socket opened.
    assert_eq!(hello_seq, before);

    let seq = write(&mut admin, &id, &counts, 2.0).await;
    let changed = next_json(&mut socket).await;
    assert_eq!(changed["type"], "cells_changed");
    assert_eq!(changed["seq"], seq);
    assert_eq!(changed["user_id"], user_id.as_str());
    // The line item that was written and the one that is calculated from it.
    let line_items: BTreeSet<&str> = changed["line_item_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    assert_eq!(
        line_items,
        BTreeSet::from([counts.units.as_str(), counts.double.as_str()])
    );

    // A change of the structure is told of with its seq alone.
    let created = admin
        .post(&url(&id, "/lists"), Some(json!({ "name": "Regions" })))
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let structure = next_json(&mut socket).await;
    assert_eq!(structure["type"], "structure_changed");
    assert!(structure["seq"].as_i64().unwrap() > seq);
    assert_eq!(structure.as_object().unwrap().len(), 2);

    // Another socket of the model hears of the next change too.
    let (mut other, _) = follow(address, &mut admin, &id).await;
    let next = write(&mut admin, &id, &counts, 3.0).await;
    assert_eq!(next_json(&mut socket).await["seq"], next);
    assert_eq!(next_json(&mut other).await["seq"], next);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_socket_hears_of_the_model_it_follows_only(pool: PgPool) {
    let (mut admin, workspace, id) = plan(&pool).await;
    let elsewhere = create_model(&mut admin, &workspace, "Elsewhere").await;
    let here = counts(&mut admin, &id).await;
    let there = counts(&mut admin, &elsewhere).await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut admin, &elsewhere).await;

    write(&mut admin, &id, &here, 1.0).await;
    assert!(quiet(&mut socket).await);

    // The next thing it hears is the change of the model it follows, not a late one of the other.
    let seq = write(&mut admin, &elsewhere, &there, 1.0).await;
    assert_eq!(next_json(&mut socket).await["seq"], seq);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn ticket_single_use(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let counts = counts(&mut admin, &id).await;
    let address = admin.serve().await;
    let ticket = ticket(&mut admin, &id).await;

    let mut socket = open(address, &id, &ticket, None).await.unwrap();
    assert_eq!(next_json(&mut socket).await["type"], "hello");
    let again = refusal(open(address, &id, &ticket, None).await);

    assert_eq!(again.0, StatusCode::FORBIDDEN);
    assert_eq!(again.1["code"], "auth.forbidden");
    // The socket that used it goes on.
    let seq = write(&mut admin, &id, &counts, 1.0).await;
    assert_eq!(next_json(&mut socket).await["seq"], seq);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn ticket_expired_refused(pool: PgPool) {
    let settings = LiveSettings {
        ticket_ttl: Duration::ZERO,
        ..LiveSettings::default()
    };
    let (mut admin, _, id) = plan_in(TestApp::with_live(pool.clone(), settings)).await;
    let address = admin.serve().await;
    let ticket = ticket(&mut admin, &id).await;

    let (status, problem) = refusal(open(address, &id, &ticket, None).await);

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(problem["code"], "auth.forbidden");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn unknown_tickets_are_refused(pool: PgPool) {
    let (admin, _, id) = plan(&pool).await;
    let address = admin.serve().await;

    for ticket in ["nonsense", "x", &"a".repeat(2000)] {
        let (status, problem) = refusal(open(address, &id, ticket, None).await);
        assert_eq!(status, StatusCode::FORBIDDEN, "{ticket}");
        assert_eq!(problem["code"], "auth.forbidden");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn ticket_for_other_model_refused(pool: PgPool) {
    let (mut admin, workspace, id) = plan(&pool).await;
    let other = create_model(&mut admin, &workspace, "Other").await;
    let address = admin.serve().await;
    let for_other = ticket(&mut admin, &other).await;

    let (status, problem) = refusal(open(address, &id, &for_other, None).await);

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(problem["code"], "auth.forbidden");
    // Trying it used it up, wherever.
    let (status, _) = refusal(open(address, &other, &for_other, None).await);
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn foreign_origin_refused(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let address = admin.serve().await;

    for origin in [
        "https://evil.example",
        "http://localhost:9999",
        "https://localhost:8080",
        "null",
    ] {
        let ticket = ticket(&mut admin, &id).await;
        let (status, problem) = refusal(open(address, &id, &ticket, Some(origin)).await);
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin}");
        assert_eq!(problem["code"], "auth.forbidden", "{origin}");
    }
    // The origin of the app, and no origin at all, are let in.
    for origin in [
        Some("http://localhost:8080"),
        Some("HTTP://LOCALHOST:8080"),
        None,
    ] {
        let ticket = ticket(&mut admin, &id).await;
        let mut socket = open(address, &id, &ticket, origin).await.unwrap();
        assert_eq!(next_json(&mut socket).await["type"], "hello", "{origin:?}");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn an_address_that_is_not_a_websocket_is_a_bad_request(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let ticket = ticket(&mut admin, &id).await;

    let response = admin
        .get(&format!("{}?ticket={ticket}", url(&id, "/live")))
        .await;

    assert_problem(&response, StatusCode::BAD_REQUEST, "bad_request");
    // The ticket was not spent on it.
    let address = admin.serve().await;
    let mut socket = open(address, &id, &ticket, None).await.unwrap();
    assert_eq!(next_json(&mut socket).await["type"], "hello");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_member_removed_before_the_socket_opens_is_refused(pool: PgPool) {
    let (mut admin, workspace, id) = plan(&pool).await;
    let vera = create_member(&mut admin, &workspace, "vera@acme.com", "Vera", "viewer").await;
    let mut viewer = sign_in_beside(&admin, "vera@acme.com").await;
    let address = admin.serve().await;
    let ticket = ticket(&mut viewer, &id).await;

    let removed = admin
        .delete(&format!("/api/v1/workspaces/{workspace}/members/{vera}"))
        .await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.text);
    let (status, problem) = refusal(open(address, &id, &ticket, None).await);

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(problem["code"], "auth.forbidden");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn removed_member_socket_closes(pool: PgPool) {
    let (mut admin, workspace, id) =
        plan_in(TestApp::with_live(pool.clone(), short(60_000, 100))).await;
    let vera = create_member(&mut admin, &workspace, "vera@acme.com", "Vera", "viewer").await;
    let mut viewer = sign_in_beside(&admin, "vera@acme.com").await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut viewer, &id).await;

    // Still a member at the first check.
    assert!(quiet(&mut socket).await);
    let removed = admin
        .delete(&format!("/api/v1/workspaces/{workspace}/members/{vera}"))
        .await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.text);

    assert_eq!(closed_with(&mut socket).await, 4403);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_disabled_user_socket_closes(pool: PgPool) {
    let (mut admin, workspace, id) =
        plan_in(TestApp::with_live(pool.clone(), short(60_000, 100))).await;
    let vera = create_member(&mut admin, &workspace, "vera@acme.com", "Vera", "viewer").await;
    let mut viewer = sign_in_beside(&admin, "vera@acme.com").await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut viewer, &id).await;

    let disabled = admin
        .patch(
            &format!("/api/v1/users/{vera}"),
            Some(json!({ "disabled": true })),
        )
        .await;
    assert_eq!(disabled.status, StatusCode::OK, "{}", disabled.text);

    assert_eq!(closed_with(&mut socket).await, 4403);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn deleted_model_socket_closes_4404(pool: PgPool) {
    // The checks are a minute apart, so it is the model being unloaded that closes the socket.
    let (mut admin, _, id) = plan(&pool).await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut admin, &id).await;

    let deleted = admin.delete(&format!("/api/v1/models/{id}")).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);

    assert_eq!(closed_with(&mut socket).await, 4404);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_model_deleted_before_the_socket_opens_is_not_found(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let address = admin.serve().await;
    let ticket = ticket(&mut admin, &id).await;
    admin.delete(&format!("/api/v1/models/{id}")).await;

    let (status, problem) = refusal(open(address, &id, &ticket, None).await);

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(problem["code"], "not_found");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn the_server_pings_every_so_often(pool: PgPool) {
    // A client that is not read for two intervals is left, so the interval is long enough that a
    // test thread kept waiting by a busy machine still answers in time.
    let (mut admin, _, id) = plan_in(TestApp::with_live(pool.clone(), short(400, 60_000))).await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut admin, &id).await;

    for _ in 0..2 {
        let message = timeout(WAIT, socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(message, Message::Ping(_)), "{message:?}");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn what_the_client_sends_is_ignored(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let counts = counts(&mut admin, &id).await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut admin, &id).await;

    socket.send(Message::text("hello?")).await.unwrap();
    socket.send(Message::binary(vec![1, 2, 3])).await.unwrap();
    socket
        .send(Message::text(r#"{"type":"subscribe"}"#))
        .await
        .unwrap();

    assert!(quiet(&mut socket).await);
    let seq = write(&mut admin, &id, &counts, 1.0).await;
    assert_eq!(next_json(&mut socket).await["seq"], seq);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_message_of_more_than_16_kib_closes_the_socket(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut admin, &id).await;

    let _ = socket.send(Message::text("x".repeat(17 << 10))).await;

    // The server drops the socket, with or without a close frame.
    let ended = timeout(WAIT, async {
        loop {
            match socket.next().await {
                None | Some(Err(_) | Ok(Message::Close(_))) => return,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the socket stayed open");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn unloading_the_models_closes_their_sockets_for_the_client_to_connect_again(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut admin, &id).await;

    admin.state.models.shutdown().await;

    assert_eq!(closed_with(&mut socket).await, 1012);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn an_open_socket_does_not_hold_up_a_graceful_shutdown(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(
        axum::serve(
            listener,
            admin
                .router
                .clone()
                .into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .into_future(),
    );
    let (_socket, _) = follow(address, &mut admin, &id).await;

    stop.send(()).unwrap();

    let ended = timeout(WAIT, server).await;
    assert!(ended.is_ok(), "the server waits for the socket to close");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_user_holds_20_tickets_at_most(pool: PgPool) {
    let (mut admin, workspace, id) = plan(&pool).await;
    create_member(&mut admin, &workspace, "vera@acme.com", "Vera", "viewer").await;
    let mut viewer = sign_in_beside(&admin, "vera@acme.com").await;
    for _ in 0..20 {
        ticket(&mut admin, &id).await;
    }

    let refused = ticket_response(&mut admin, &id).await;

    assert_problem(&refused, StatusCode::TOO_MANY_REQUESTS, "auth.rate_limited");
    assert_eq!(refused.headers["retry-after"], "60");
    // Another user is not held up by it.
    ticket(&mut viewer, &id).await;
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_user_has_20_sockets_open_at_most(pool: PgPool) {
    let (mut admin, workspace, id) = plan(&pool).await;
    create_member(&mut admin, &workspace, "vera@acme.com", "Vera", "viewer").await;
    let mut viewer = sign_in_beside(&admin, "vera@acme.com").await;
    let address = admin.serve().await;
    let mut sockets = Vec::new();
    for _ in 0..20 {
        sockets.push(follow(address, &mut admin, &id).await.0);
    }

    let ticket_for_the_21st = ticket(&mut admin, &id).await;
    let (status, problem, retry) =
        refusal_with_retry(open(address, &id, &ticket_for_the_21st, None).await);

    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(problem["code"], "auth.rate_limited");
    assert_eq!(retry.as_deref(), Some("30"));
    // Another user is not held up by it.
    follow(address, &mut viewer, &id).await;
    // A socket that closes makes room: the server gives its place back when it has seen it close.
    let mut closing = sockets.pop().unwrap();
    closing.close(None).await.unwrap();
    while let Some(Ok(_)) = timeout(WAIT, closing.next()).await.unwrap() {}
    let mut tries = 0;
    loop {
        let ticket = ticket(&mut admin, &id).await;
        match open(address, &id, &ticket, None).await {
            Ok(mut socket) => {
                assert_eq!(next_json(&mut socket).await["type"], "hello");
                break;
            }
            Err(_) if tries < 50 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => panic!("the place was not given back: {error}"),
        }
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_socket_whose_client_answers_no_pings_is_closed(pool: PgPool) {
    // The interval is long enough that the client that reads, which has two intervals to answer a
    // ping in, is not left because the machine kept the test waiting.
    let ping_every = 400;
    let (mut admin, _, id) =
        plan_in(TestApp::with_live(pool.clone(), short(ping_every, 60_000))).await;
    let address = admin.serve().await;
    let (mut silent, _) = follow(address, &mut admin, &id).await;
    let (mut listening, _) = follow(address, &mut admin, &id).await;

    // A client that reads answers the pings of several intervals, and stays.
    assert!(stays_open(&mut listening, Duration::from_millis(ping_every * 5)).await);

    // The one that did not read has been left by the server after the first ping that nothing
    // answered, without a word about it: it finds the connection gone.
    let mut pings = 0;
    let ended = timeout(WAIT, async {
        loop {
            match silent.next().await {
                None | Some(Err(_)) => return None,
                Some(Ok(Message::Close(frame))) => return frame,
                Some(Ok(Message::Ping(_))) => pings += 1,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(
        matches!(ended, Ok(None)),
        "the socket was not left as it should: {ended:?}"
    );
    assert_eq!(pings, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_client_that_sends_too_often_is_closed(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut admin, &id).await;

    for at in 0..25 {
        if socket.send(Message::text(format!("{at}"))).await.is_err() {
            break;
        }
    }

    assert_eq!(closed_with(&mut socket).await, 1008);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn the_server_answers_a_client_that_closes(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut admin, &id).await;

    socket.close(None).await.unwrap();

    // The close is answered, and the connection ends there and not in a reset.
    let mut answered = false;
    loop {
        match timeout(WAIT, socket.next()).await.unwrap() {
            Some(Ok(Message::Close(_))) => answered = true,
            Some(Ok(_)) => {}
            Some(Err(error)) => {
                assert!(
                    matches!(error, tungstenite::Error::ConnectionClosed),
                    "{error}"
                );
                break;
            }
            None => break,
        }
    }
    assert!(answered, "the server did not answer the close");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn an_instance_admin_who_is_no_member_follows_a_model(pool: PgPool) {
    let (mut admin, _, id) = plan_in(TestApp::with_live(pool.clone(), short(60_000, 100))).await;
    let boss = admin
        .post(
            "/api/v1/users",
            Some(json!({
                "email": "boss@acme.com",
                "name": "Bo Boss",
                "password": common::PASSWORD,
                "is_instance_admin": true,
            })),
        )
        .await;
    assert_eq!(boss.status, StatusCode::CREATED, "{}", boss.text);
    let mut boss = sign_in_beside(&admin, "boss@acme.com").await;
    let address = admin.serve().await;
    let (mut socket, _) = follow(address, &mut boss, &id).await;

    // Several checks later, with no membership to find, the socket is open.
    assert!(quiet(&mut socket).await);
    assert!(quiet(&mut socket).await);
}

/// The server on a port of the local machine with a send buffer of a few kilobytes, and a client
/// of it with a receive buffer as small, so that a client that does not read holds up the
/// server's sends after a few dozen messages and not a few thousand.
async fn follow_through_small_buffers(app: &mut TestApp, model: &str) -> Socket {
    let server = TcpSocket::new_v4().unwrap();
    server.set_send_buffer_size(2048).unwrap();
    server.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listener = server.listen(16).unwrap();
    let address = listener.local_addr().unwrap();
    let router = app
        .router
        .clone()
        .into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    let ticket = ticket(app, model).await;
    let client = TcpSocket::new_v4().unwrap();
    client.set_recv_buffer_size(2048).unwrap();
    let stream = client.connect(address).await.unwrap();
    let request = format!("ws://{address}/api/v1/models/{model}/live?ticket={ticket}")
        .into_client_request()
        .unwrap();
    let (mut socket, _) = client_async(request, MaybeTlsStream::Plain(stream))
        .await
        .unwrap();
    assert_eq!(next_json(&mut socket).await["type"], "hello");
    socket
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_socket_that_falls_behind_is_told_to_resync_and_goes_on(pool: PgPool) {
    // Two events of room for a subscriber that falls behind, and a client that reads nothing
    // while the model is changed 200 times.
    let settings_pool = pool.clone();
    let (mut admin, _, id) = plan_in(TestApp::with_state(pool.clone(), move |state| {
        state.models =
            ModelRegistry::with_event_buffer(settings_pool, Duration::from_secs(1800), 2);
    }))
    .await;
    let counts = counts(&mut admin, &id).await;
    let mut socket = follow_through_small_buffers(&mut admin, &id).await;
    let mut last = 0;
    for at in 0..200 {
        last = write(&mut admin, &id, &counts, f64::from(at)).await;
    }

    // What the client reads is some of the changes, then the word that it missed some, and the
    // last change, which is among the newest and so is not lost.
    let mut resync = None;
    loop {
        let message = next_json(&mut socket).await;
        match message["type"].as_str().unwrap() {
            "resync" => resync = Some(message["seq"].as_i64().unwrap()),
            _ if message["seq"] == last => break,
            _ => {}
        }
    }
    let resync = resync.expect("the client missed changes and was not told");
    // It was told of the model as it was then, which is not before a change that it is told of
    // later.
    assert!(
        resync >= last - 2,
        "the resync says {resync}, the last change is {last}"
    );
    // It follows on.
    let next = write(&mut admin, &id, &counts, 1_000.0).await;
    loop {
        if next_json(&mut socket).await["seq"] == next {
            break;
        }
    }
}
