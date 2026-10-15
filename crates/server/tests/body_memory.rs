//! A body with the NUL character is refused without parsing it, which would take many times its
//! size in memory. This is a test of its own because it counts every allocation of the process.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::DefaultBodyLimit,
    http::{Request, StatusCode, header},
    routing::post,
};
use openplan_server::extract::ApiJson;
use serde::Deserialize;
use serde_json::Value;
use tower::ServiceExt;

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
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[derive(Deserialize)]
struct Sample {
    note: String,
    edits: Vec<u8>,
}

/// A body of about 30 MiB: a text with the NUL character and then an array of 15 million
/// elements, each of which a parsed document would keep in 32 bytes.
fn large_body_with_a_nul() -> Vec<u8> {
    let mut body = br#"{"note":"a\u0000b","edits":["#.to_vec();
    body.extend("0,".repeat(15 << 20).as_bytes());
    body.extend(b"0]}");
    body
}

#[tokio::test]
async fn a_large_body_with_the_nul_character_is_refused_without_a_copy_of_its_elements() {
    let router = Router::new().route(
        "/",
        post(|ApiJson(sample): ApiJson<Sample>| async move {
            format!("{}{}", sample.note, sample.edits.len())
        })
        .layer(DefaultBodyLimit::max(64 << 20)),
    );
    let body = large_body_with_a_nul();
    assert!(body.len() > 30 << 20);
    let request = Request::post("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap();
    let before = CURRENT.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);

    let response = router.oneshot(request).await.unwrap();

    let extra = PEAK.load(Ordering::Relaxed) - before;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let problem: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(problem["errors"][0]["field"], "body");
    assert_eq!(
        problem["errors"][0]["message"],
        "Text can't contain the NUL character."
    );
    assert!(
        extra < 1 << 20,
        "refusing the body allocated {extra} bytes at its peak"
    );
}
