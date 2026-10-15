//! A chunk that declares a huge size must be refused without allocating it. This is a test of
//! its own because it counts every allocation of the process.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};

use openplan_engine::{
    AxisSpec, Calendar, Command, Format, InputChunk, LineItem, LineItemId, Model, ModuleId,
    SummaryMethod, TimeScale, VersionsScope,
};

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

const BLOCK: usize = 128 << 10;
const BLOCKS: usize = 8 << 10;
const HEAD: [u8; 9] = [
    1, // chunk format
    0, // numbers
    0, // no period level
    1, // fiscal year starts in January
    0, // no axes
    1, 0, 0, 0, // one cell
];

/// A zstd frame of a valid head of a chunk of one number and then a gibibyte of zeros, which
/// takes 32 KiB: a raw block for the head and blocks that repeat one byte, and a header that
/// says how large it is.
fn gibibyte_of_zeros() -> Vec<u8> {
    let block = |size: usize, kind: u32, last: bool| {
        let header = ((size as u32) << 3) | (kind << 1) | u32::from(last);
        header.to_le_bytes()[..3].to_vec()
    };
    let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd];
    frame.push(0xc0); // an 8-byte content size, no checksum, no dictionary
    frame.push(0x50); // a window of 1 MiB
    frame.extend(((HEAD.len() + BLOCK * BLOCKS) as u64).to_le_bytes());
    frame.extend(block(HEAD.len(), 0, false));
    frame.extend(HEAD);
    for index in 0..BLOCKS {
        frame.extend(block(BLOCK, 1, index == BLOCKS - 1));
        frame.push(0);
    }
    frame
}

#[test]
fn a_chunk_that_declares_a_gibibyte_is_refused_without_allocating_it() {
    let frame = gibibyte_of_zeros();
    // The frame is a good one that says what the bomb is made to say.
    let declared = zstd::zstd_safe::get_frame_content_size(&frame).unwrap();
    assert_eq!(declared, Some((HEAD.len() + BLOCK * BLOCKS) as u64));
    let mut start = Vec::new();
    zstd::Decoder::with_buffer(&frame[..])
        .unwrap()
        .take(10 << 20)
        .read_to_end(&mut start)
        .unwrap();
    assert_eq!(start.len(), 10 << 20);

    let mut model = Model::new(Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years: 1,
        current_month: None,
    });
    let module = ModuleId::new();
    model
        .apply(Command::CreateModule {
            id: module,
            name: "Settings".to_string(),
            axes: Vec::<AxisSpec>::new(),
            functional_area: String::new(),
        })
        .unwrap();
    let rate = LineItemId::new();
    model
        .apply(Command::CreateLineItem(LineItem {
            id: rate,
            module,
            name: "Rate".to_string(),
            ordinal: 0,
            format: Format::number(),
            formula: None,
            summary: SummaryMethod::Sum,
            time_summary: None,
            applies_to: None,
            time_scale: TimeScale::Module,
            versions: VersionsScope::Module,
            notes: String::new(),
            code: None,
            read_access_driver: None,
            write_access_driver: None,
        }))
        .unwrap();
    let doc = model.export_structure();
    let chunk = InputChunk {
        line_item: rate,
        chunk: 0,
        data: frame,
    };

    let before = CURRENT.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let error = Model::from_parts(doc, vec![chunk]).unwrap_err();
    let extra = PEAK.load(Ordering::Relaxed) - before;

    assert_eq!(error.code(), "structure.invalid");
    assert!(
        error.to_string().contains("more than its head allows"),
        "{error}"
    );
    assert!(extra < 16 << 20, "{extra} bytes were allocated at once");
}
