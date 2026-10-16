//! How much memory a request to write or read cells takes while its body is read and parsed. This
//! is a test of its own because it counts every allocation of the process, and it is one test so
//! that no other request counts in the peak it measures.

mod common;

use std::alloc::{GlobalAlloc, Layout, System};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::http::StatusCode;
use common::{
    TestApp, create_items, create_line_item, create_list, create_module, id_of, list_axis, month,
    plan, url,
};
use serde_json::json;
use sqlx::PgPool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

/// The system allocator, which keeps track of the most bytes that were allocated at once.
struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            let now = CURRENT.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, new_size) };
        if !moved.is_null() {
            let now = if new_size >= layout.size() {
                CURRENT.fetch_add(new_size - layout.size(), Ordering::Relaxed)
                    + (new_size - layout.size())
            } else {
                CURRENT.fetch_sub(layout.size() - new_size, Ordering::Relaxed)
                    - (layout.size() - new_size)
            };
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// What the peak of a request may be above what the process held before it. Render's free plan
/// has 512 MB, and the server holds its models in the rest.
const PEAK_LIMIT: usize = 200 << 20;

struct Sent {
    status: u16,
    /// The most bytes held at once by the whole process during the request, above what it held
    /// before.
    peak: usize,
}

/// Posts `body` to the server over a socket, as a browser does, so that it is read from the
/// connection in the pieces it arrives in and not handed over whole.
async fn post(address: SocketAddr, app: &TestApp, path: &str, body: &[u8]) -> Sent {
    let (cookie, csrf) = app.credentials();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nCookie: {cookie}\r\nx-openplan-csrf: {csrf}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut stream = TcpStream::connect(address).await.unwrap();
    let before = CURRENT.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    stream.write_all(head.as_bytes()).await.unwrap();
    // The server may answer before the end of a body it refuses, and then close the connection.
    let _ = stream.write_all(body).await;
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response).await;
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(before);
    let status = std::str::from_utf8(&response[..response.len().min(12)])
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    Sent { status, peak }
}

fn mebibytes(bytes: usize) -> f64 {
    bytes as f64 / (1 << 20) as f64
}

/// The labels of the months of 2026 to 2028.
fn months() -> Vec<String> {
    const NAMES: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    (26..=28)
        .flat_map(|year| NAMES.iter().map(move |name| format!("{name} {year}")))
        .collect()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn reading_and_parsing_the_body_of_a_cells_request_is_bounded(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let names = |prefix: &str| -> Vec<_> {
        (0..100)
            .map(|at| json!({ "name": format!("{prefix} {at}") }))
            .collect()
    };
    let mut axes = Vec::new();
    let mut members = Vec::new();
    for prefix in ["Product", "Channel"] {
        let list = create_list(&mut admin, &id, json!({ "name": prefix })).await;
        let items = create_items(&mut admin, &id, &list, json!(names(prefix))).await;
        members.push(items.iter().map(id_of).collect::<Vec<_>>());
        axes.push(list_axis(&list));
    }
    axes.push(month());
    let module = create_module(&mut admin, &id, "Sales", axes).await;
    let units =
        id_of(&create_line_item(&mut admin, &id, &module, json!({ "name": "Units" })).await);
    let months = months();
    let address = admin.serve().await;
    let write = url(&id, "/cells");

    // The largest write there can be: 100,000 different cells of a line item with three
    // dimensions, which is some 20 MiB of JSON.
    let mut body = String::from(r#"{"edits":["#);
    for at in 0..100_000usize {
        if at > 0 {
            body.push(',');
        }
        body.push_str(&format!(
            r#"{{"line_item_id":"{units}","coords":["{}","{}","{}"],"value":{{"t":"number","v":1.5}}}}"#,
            members[0][at % 100],
            members[1][(at / 100) % 100],
            months[at / 10_000],
        ));
    }
    body.push_str("]}");
    let largest = post(address, &admin, &write, body.as_bytes()).await;
    eprintln!(
        "100,000 edits ({:.1} MiB): status {}, peak +{:.0} MiB",
        mebibytes(body.len()),
        largest.status,
        mebibytes(largest.peak)
    );
    assert_eq!(largest.status, StatusCode::OK.as_u16());
    assert!(largest.peak < PEAK_LIMIT, "{} bytes", largest.peak);
    drop(body);

    // One edit whose coordinates are millions of empty texts, three bytes each, which a parsed
    // request keeps in 32 bytes each, and in twice that while the list of them grows.
    let mut body = format!(r#"{{"edits":[{{"line_item_id":"{units}","coords":["#);
    body.push_str(&r#""","#.repeat(9 << 20));
    body.push_str(r#"""],"value":{"t":"number","v":1}}]}"#);
    let coordinates = post(address, &admin, &write, body.as_bytes()).await;
    eprintln!(
        "one edit of 9 million coordinates ({:.1} MiB): status {}, peak +{:.0} MiB",
        mebibytes(body.len()),
        coordinates.status,
        mebibytes(coordinates.peak)
    );
    assert_eq!(
        coordinates.status,
        StatusCode::UNPROCESSABLE_ENTITY.as_u16()
    );
    assert!(coordinates.peak < PEAK_LIMIT, "{} bytes", coordinates.peak);
    drop(body);

    // The most that a parsed write can take: 100,000 edits with 16 coordinates of one letter
    // each, which are kept in 64 bytes each.
    let mut body = String::from(r#"{"edits":["#);
    let widest = format!(
        r#"{{"line_item_id":"{units}","coords":[{}"a"],"value":{{"t":"boolean","v":true}}}},"#,
        r#""a","#.repeat(15)
    );
    body.push_str(&widest.repeat(100_000));
    body.pop();
    body.push_str("]}");
    let widest = post(address, &admin, &write, body.as_bytes()).await;
    eprintln!(
        "100,000 edits of 16 coordinates ({:.1} MiB): status {}, peak +{:.0} MiB",
        mebibytes(body.len()),
        widest.status,
        mebibytes(widest.peak)
    );
    assert_eq!(widest.status, StatusCode::UNPROCESSABLE_ENTITY.as_u16());
    assert!(widest.peak < PEAK_LIMIT, "{} bytes", widest.peak);
    drop(body);

    // Hundreds of thousands of edits with nothing in them but their line item.
    let mut body = String::from(r#"{"edits":["#);
    let tiny =
        format!(r#"{{"line_item_id":"{units}","coords":[],"value":{{"t":"boolean","v":true}}}},"#);
    body.push_str(&tiny.repeat(300_000));
    body.push_str(&tiny[..tiny.len() - 1]);
    body.push_str("]}");
    let many = post(address, &admin, &write, body.as_bytes()).await;
    eprintln!(
        "300,001 edits ({:.1} MiB): status {}, peak +{:.0} MiB",
        mebibytes(body.len()),
        many.status,
        mebibytes(many.peak)
    );
    assert_eq!(many.status, StatusCode::UNPROCESSABLE_ENTITY.as_u16());
    assert!(many.peak < PEAK_LIMIT, "{} bytes", many.peak);
    drop(body);

    // A read of 8 MiB of cells that have no coordinates, three bytes each, which a parsed request
    // keeps in 24 bytes each.
    let read = url(&id, "/cells/read");
    let mut body = format!(r#"{{"line_item_id":"{units}","cells":["#);
    body.push_str(&"[],".repeat(2_700_000));
    body.push_str("[]]}");
    let cells = post(address, &admin, &read, body.as_bytes()).await;
    eprintln!(
        "a read of 2,700,001 cells ({:.1} MiB): status {}, peak +{:.0} MiB",
        mebibytes(body.len()),
        cells.status,
        mebibytes(cells.peak)
    );
    assert_eq!(cells.status, StatusCode::UNPROCESSABLE_ENTITY.as_u16());
    assert!(cells.peak < PEAK_LIMIT, "{} bytes", cells.peak);
}
