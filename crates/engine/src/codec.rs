//! Saving and loading a model (spec §6): its structure as a document, and the cells typed into
//! input line items as compressed chunks.
//!
//! A chunk holds the non-blank cells of one input line item, at most [`CHUNK_CELLS`] of them,
//! in the order of the line item's grid. A cell is addressed by what lies at each of its
//! coordinates, the id of the item or version and the index of the period, and not by its
//! position, so that chunks still load after items were reordered, added or deleted: the cells
//! of items that are gone are left out and counted in [`Model::load_warnings`].
//!
//! Before zstd compresses it, a chunk is, little-endian throughout:
//!
//! - a byte for the format of the chunk, a byte for the kind of value, a byte for the number of
//!   axes and a `u32` for the number of cells;
//! - for each axis, a `u32` count and that many 16-byte keys: the ids or period indices that the
//!   cells of the chunk lie on;
//! - for each axis, the index into its keys for every cell, in 1, 2 or 4 bytes as the count of
//!   keys needs;
//! - the value of every cell: 8 bytes for a number, 1 for a boolean, a `u32` length and the
//!   bytes of the text, 4 for a date or a period, and the 16-byte id of the item.

use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::calendar::{Calendar, TimeRange};
use crate::command::{Command, ItemSpec, LineItemPatch};
use crate::error::EngineError;
use crate::ids::{ItemId, LineItemId, ListId};
use crate::model::{EPOCH_DAYS_FROM_CE, Model};
use crate::shape::{Axis, Shape};
use crate::structure::{Layout, LineItem, List, Module, Structure, Subset, SummaryMethod, Version};
use crate::value::{BLANK_DATE, BLANK_PERIOD, Column, ValueType};

/// The version of the structure document this build writes and reads.
const STRUCTURE_FORMAT: u32 = 1;

/// The version of the chunk encoding this build writes and reads.
const CHUNK_FORMAT: u8 = 1;

/// Most cells in a chunk.
const CHUNK_CELLS: usize = 1_000_000;

/// Most bytes a chunk may take once decompressed: room for the largest chunk of the widest
/// cells, so that a damaged size cannot make a load allocate without bound.
const MAX_DECODED_BYTES: u64 = 1 << 30;

/// Stands for a cell that is left out, in place of its position.
const LEFT_OUT: usize = usize::MAX;

/// Everything about a model apart from the values of its cells, as it is stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructureDoc {
    pub format_version: u32,
    pub calendar: Calendar,
    pub lists: Vec<ListDoc>,
    pub subsets: Vec<Subset>,
    pub versions: Vec<Version>,
    pub time_ranges: Vec<TimeRange>,
    pub modules: Vec<Module>,
    pub line_items: Vec<LineItem>,
}

/// A list and its items, without the items that were deleted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListDoc {
    pub id: ListId,
    pub name: String,
    pub parent: Option<ListId>,
    pub top_level_name: Option<String>,
    pub numbered: bool,
    pub production_data: bool,
    pub selective_access: bool,
    pub items: Vec<ItemDoc>,
}

/// An item of a list, in the order of the list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemDoc {
    pub id: ItemId,
    pub code: Option<String>,
    pub name: String,
    pub parent: Option<ItemId>,
}

impl ListDoc {
    fn of(list: &List) -> ListDoc {
        ListDoc {
            id: list.id,
            name: list.name.clone(),
            parent: list.parent,
            top_level_name: list.top_level_name.clone(),
            numbered: list.numbered,
            production_data: list.production_data,
            selective_access: list.selective_access,
            items: list
                .items()
                .map(|(_, item)| ItemDoc {
                    id: item.id,
                    code: item.code.clone(),
                    name: item.name.clone(),
                    parent: item.parent,
                })
                .collect(),
        }
    }
}

/// The non-blank cells of an input line item, or some of them, compressed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputChunk {
    pub line_item: LineItemId,
    /// The number of the chunk among those of its line item, from 0.
    pub chunk: u32,
    pub data: Vec<u8>,
}

impl Model {
    /// The structure of the model as a document that [`Model::from_parts`] reads back.
    pub fn export_structure(&self) -> StructureDoc {
        let structure = self.structure();
        StructureDoc {
            format_version: STRUCTURE_FORMAT,
            calendar: structure.calendar,
            lists: structure.lists().map(ListDoc::of).collect(),
            subsets: structure.subsets().cloned().collect(),
            versions: structure.versions().to_vec(),
            time_ranges: structure.time_ranges().cloned().collect(),
            modules: structure.modules().cloned().collect(),
            line_items: structure.line_items().cloned().collect(),
        }
    }

    /// The cells typed into every input line item, in chunks ordered by line item and then by
    /// number. Line items with no non-blank cells have none.
    pub fn export_inputs(&self) -> Vec<InputChunk> {
        let ids: Vec<LineItemId> = self
            .structure()
            .line_items()
            .filter(|line_item| line_item.formula.is_none())
            .map(|line_item| line_item.id)
            .collect();
        ids.par_iter()
            .flat_map_iter(|&id| self.export_inputs_for(id))
            .collect()
    }

    /// The cells typed into one input line item, in chunks. A calculated line item, or one
    /// that does not exist, has none.
    pub fn export_inputs_for(&self, li: LineItemId) -> Vec<InputChunk> {
        let structure = self.structure();
        let Some(line_item) = structure
            .line_item(li)
            .filter(|line_item| line_item.formula.is_none())
        else {
            return Vec::new();
        };
        let Some(column) = self.input_cells(li) else {
            return Vec::new();
        };
        let encoder = Encoder::new(structure, line_item, column);
        let positions: Vec<usize> = (0..column.len())
            .filter(|&position| !column.is_blank_at(position))
            .collect();
        positions
            .par_chunks(CHUNK_CELLS)
            .enumerate()
            .map(|(number, positions)| InputChunk {
                line_item: li,
                chunk: number as u32,
                data: encoder.encode(positions),
            })
            .collect()
    }

    /// Builds a model from the structure and the stored cells of its input line items, and
    /// calculates the other line items.
    ///
    /// Cells of `chunks` that lie on items, versions or periods the structure does not have, or
    /// belong to line items it does not have or that are calculated, or are of another kind
    /// than their line item, are left out and counted by [`Model::load_warnings`]. A structure
    /// that is not consistent, or a chunk that is damaged, is an error.
    pub fn from_parts(doc: StructureDoc, chunks: Vec<InputChunk>) -> Result<Model, EngineError> {
        let structure = rebuild(doc)?;
        let (inputs, left_out) = load_inputs(&structure, chunks)?;
        Model::assemble(structure, inputs, left_out)
    }
}

fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::Invalid {
        message: message.into(),
    }
}

fn damaged(what: &str) -> EngineError {
    invalid(format!("A chunk of stored cells is damaged: {what}."))
}

/// The structure a document describes, made by the commands that make one so that everything
/// they check is checked.
fn rebuild(doc: StructureDoc) -> Result<Structure, EngineError> {
    if doc.format_version != STRUCTURE_FORMAT {
        return Err(invalid(format!(
            "Structure format {} is not supported.",
            doc.format_version
        )));
    }
    let mut structure = Structure::new(doc.calendar);
    structure.apply(Command::SetCalendar {
        calendar: doc.calendar,
    })?;
    structure.restore_versions(doc.versions)?;
    create_lists(&mut structure, doc.lists)?;
    for range in doc.time_ranges {
        structure.apply(Command::CreateTimeRange {
            id: range.id,
            name: range.name,
            first_year: range.first_year,
            years: range.years,
        })?;
    }
    for subset in doc.subsets {
        structure.apply(Command::CreateSubset {
            id: subset.id,
            list: subset.list,
            name: subset.name,
            items: subset.items,
        })?;
    }
    let (properties, modules): (Vec<Module>, Vec<Module>) = doc
        .modules
        .into_iter()
        .partition(|module| structure.list(ListId(module.id.0)).is_some());
    for module in modules {
        structure.apply(Command::CreateModule {
            id: module.id,
            name: module.name,
            axes: module.axes,
            functional_area: module.functional_area,
        })?;
    }
    for module in properties {
        structure.restore_properties_module(module)?;
    }
    create_line_items(&mut structure, doc.line_items)?;
    Ok(structure)
}

/// Creates the lists with their items, each list after the list it is the hierarchy level of.
fn create_lists(structure: &mut Structure, lists: Vec<ListDoc>) -> Result<(), EngineError> {
    let mut created: HashSet<ListId> = HashSet::new();
    let mut waiting = lists;
    while !waiting.is_empty() {
        let (ready, rest): (Vec<ListDoc>, Vec<ListDoc>) = waiting
            .into_iter()
            .partition(|list| list.parent.is_none_or(|parent| created.contains(&parent)));
        if ready.is_empty() {
            return Err(invalid(
                "A list has a parent list that is missing, or lists are each other's parents.",
            ));
        }
        for list in ready {
            structure.apply(Command::CreateList {
                id: list.id,
                name: list.name,
                parent: list.parent,
                top_level_name: list.top_level_name,
                numbered: list.numbered,
                production_data: list.production_data,
            })?;
            if list.selective_access {
                structure.apply(Command::UpdateList {
                    id: list.id,
                    name: None,
                    top_level_name: None,
                    production_data: None,
                    selective_access: Some(true),
                })?;
            }
            if !list.items.is_empty() {
                let items = list
                    .items
                    .into_iter()
                    .map(|item| ItemSpec {
                        id: item.id,
                        code: item.code,
                        name: item.name,
                        parent: item.parent,
                    })
                    .collect();
                structure.apply(Command::UpsertListItems {
                    list: list.id,
                    items,
                })?;
            }
            created.insert(list.id);
        }
        waiting = rest;
    }
    Ok(())
}

/// Creates the line items. A line item can name another as a ratio part or an access driver,
/// and the two can name each other, so those are set once all of them exist.
fn create_line_items(
    structure: &mut Structure,
    line_items: Vec<LineItem>,
) -> Result<(), EngineError> {
    let mut linked = Vec::new();
    for line_item in line_items {
        let mut bare = line_item.clone();
        if matches!(bare.summary, SummaryMethod::Ratio { .. }) {
            bare.summary = SummaryMethod::Sum;
        }
        if matches!(bare.time_summary, Some(SummaryMethod::Ratio { .. })) {
            bare.time_summary = None;
        }
        bare.read_access_driver = None;
        bare.write_access_driver = None;
        if bare != line_item {
            linked.push((
                line_item.id,
                LineItemPatch {
                    summary: Some(line_item.summary),
                    time_summary: Some(line_item.time_summary),
                    read_access_driver: Some(line_item.read_access_driver),
                    write_access_driver: Some(line_item.write_access_driver),
                    ..LineItemPatch::default()
                },
            ));
        }
        structure.apply(Command::CreateLineItem(bare))?;
    }
    for (id, patch) in linked {
        structure.apply(Command::UpdateLineItem { id, patch })?;
    }
    Ok(())
}

/// What a chunk holds one of per cell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Number = 0,
    Boolean = 1,
    Text = 2,
    Date = 3,
    Item = 4,
    Period = 5,
}

impl Kind {
    const ALL: [Kind; 6] = [
        Kind::Number,
        Kind::Boolean,
        Kind::Text,
        Kind::Date,
        Kind::Item,
        Kind::Period,
    ];

    fn of(ty: &ValueType) -> Kind {
        match ty {
            ValueType::Number => Kind::Number,
            ValueType::Boolean => Kind::Boolean,
            ValueType::Text => Kind::Text,
            ValueType::Date => Kind::Date,
            ValueType::Item(_) => Kind::Item,
            ValueType::Period(_) => Kind::Period,
        }
    }
}

/// The width in bytes of an index into `keys` keys.
fn index_width(keys: usize) -> usize {
    match keys {
        0..=0x100 => 1,
        0x101..=0x1_0000 => 2,
        _ => 4,
    }
}

/// Turns the cells of one input line item into chunks.
struct Encoder<'a> {
    kind: Kind,
    column: &'a Column,
    shape: Shape,
    /// What lies at each position of each axis, `None` where an item was deleted.
    keys: Vec<Vec<Option<u128>>>,
    /// What lies at each position of the list of an item-valued line item.
    items: Vec<Option<u128>>,
}

impl<'a> Encoder<'a> {
    fn new(structure: &Structure, line_item: &LineItem, column: &'a Column) -> Encoder<'a> {
        let layout = structure
            .layout(line_item)
            .expect("a line item of a structure has a layout");
        let shape = structure
            .shape_of(&layout)
            .expect("a line item of a structure has a shape");
        let keys = layout
            .axes
            .iter()
            .map(|axis| {
                structure
                    .axis_keys(axis, layout.restriction.as_deref())
                    .expect("an axis of a layout is in the structure")
            })
            .collect();
        let ty = line_item.format.value_type();
        let items = match ty {
            ValueType::Item(list) => structure
                .axis_keys(&Axis::List(list), None)
                .expect("the list of a line item is in the structure"),
            _ => Vec::new(),
        };
        Encoder {
            kind: Kind::of(&ty),
            column,
            shape,
            keys,
            items,
        }
    }

    /// The compressed chunk of the cells at `positions`, which are in order.
    fn encode(&self, positions: &[usize]) -> Vec<u8> {
        let axes = self.shape.lens.len();
        let mut slots: Vec<Vec<Option<u32>>> = self
            .shape
            .lens
            .iter()
            .map(|&len| vec![None; len as usize])
            .collect();
        let mut dictionaries: Vec<Vec<u128>> = vec![Vec::new(); axes];
        let mut indices: Vec<Vec<u32>> = vec![Vec::with_capacity(positions.len()); axes];
        let mut values = Vec::new();
        let mut coords = vec![0; axes];
        let mut row = Vec::with_capacity(axes);
        let mut count = 0u32;
        for &position in positions {
            self.shape.coords(position, &mut coords);
            row.clear();
            for (keys, &coord) in self.keys.iter().zip(&coords) {
                match keys[coord as usize] {
                    Some(key) => row.push(key),
                    None => break,
                }
            }
            if row.len() < axes || !self.put_value(&mut values, position) {
                continue;
            }
            for (axis, &key) in row.iter().enumerate() {
                let slot = &mut slots[axis][coords[axis] as usize];
                let index = *slot.get_or_insert_with(|| {
                    dictionaries[axis].push(key);
                    (dictionaries[axis].len() - 1) as u32
                });
                indices[axis].push(index);
            }
            count += 1;
        }

        let mut bytes = Vec::with_capacity(values.len() + positions.len() * axes * 2);
        bytes.extend([CHUNK_FORMAT, self.kind as u8, axes as u8]);
        bytes.extend(count.to_le_bytes());
        for dictionary in &dictionaries {
            bytes.extend((dictionary.len() as u32).to_le_bytes());
            for key in dictionary {
                bytes.extend(key.to_le_bytes());
            }
        }
        for (dictionary, indices) in dictionaries.iter().zip(&indices) {
            match index_width(dictionary.len()) {
                1 => bytes.extend(indices.iter().map(|&index| index as u8)),
                2 => bytes.extend(
                    indices
                        .iter()
                        .flat_map(|&index| (index as u16).to_le_bytes()),
                ),
                _ => bytes.extend(indices.iter().flat_map(|index| index.to_le_bytes())),
            }
        }
        bytes.extend(values);
        zstd::bulk::compress(&bytes, zstd::DEFAULT_COMPRESSION_LEVEL)
            .expect("compressing into a buffer of the largest possible size cannot fail")
    }

    /// Appends the value of the cell at `position`. A cell whose value is the id of an item
    /// that was deleted is left out, and so nothing is appended.
    fn put_value(&self, values: &mut Vec<u8>, position: usize) -> bool {
        match self.column {
            Column::Number(cells) => values.extend(cells[position].to_le_bytes()),
            Column::Boolean(cells) => values.push(u8::from(cells[position])),
            Column::Text(cells) => {
                let text = &cells[position];
                values.extend((text.len() as u32).to_le_bytes());
                values.extend(text.as_bytes());
            }
            Column::Date(cells) => values.extend(cells[position].to_le_bytes()),
            Column::Period(cells) => values.extend(cells[position].to_le_bytes()),
            Column::Item(cells) => {
                let Some(id) = self.items.get(cells[position] as usize).copied().flatten() else {
                    return false;
                };
                values.extend(id.to_le_bytes());
            }
        }
        true
    }
}

/// Reads the fields of a chunk, refusing to read past its end.
struct Reader<'a> {
    bytes: &'a [u8],
    read: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], EngineError> {
        let rest = &self.bytes[self.read..];
        if rest.len() < len {
            return Err(damaged("it ends too soon"));
        }
        self.read += len;
        Ok(&rest[..len])
    }

    fn byte(&mut self) -> Result<u8, EngineError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, EngineError> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

fn le_u128(bytes: &[u8]) -> u128 {
    u128::from_le_bytes(bytes.try_into().expect("keys are 16 bytes"))
}

/// A chunk taken apart.
struct Chunk {
    kind: Kind,
    count: usize,
    /// For each axis, the keys the cells of the chunk lie on.
    dictionaries: Vec<Vec<u128>>,
    /// For each axis, for each cell, the index into the keys of the axis.
    indices: Vec<Vec<u32>>,
    decompressed: Vec<u8>,
    /// Where in `decompressed` the values of the cells start.
    values_at: usize,
}

impl Chunk {
    fn parse(data: &[u8]) -> Result<Chunk, EngineError> {
        let size = zstd::zstd_safe::get_frame_content_size(data)
            .map_err(|_| damaged("it is not compressed data"))?
            .filter(|&size| size <= MAX_DECODED_BYTES)
            .ok_or_else(|| damaged("it does not say a size that can be read"))?;
        let decompressed = zstd::bulk::decompress(data, size as usize)
            .map_err(|_| damaged("it does not decompress"))?;
        let mut reader = Reader {
            bytes: &decompressed,
            read: 0,
        };
        if reader.byte()? != CHUNK_FORMAT {
            return Err(damaged("its format is not supported"));
        }
        let kind = Kind::ALL
            .get(usize::from(reader.byte()?))
            .copied()
            .ok_or_else(|| damaged("it holds an unknown kind of value"))?;
        let axes = usize::from(reader.byte()?);
        let count = reader.u32()? as usize;
        if count > CHUNK_CELLS {
            return Err(damaged("it has too many cells"));
        }
        let mut dictionaries = Vec::with_capacity(axes);
        for _ in 0..axes {
            let len = reader.u32()? as usize;
            let keys = reader.take(len.saturating_mul(16))?;
            dictionaries.push(keys.chunks_exact(16).map(le_u128).collect::<Vec<_>>());
        }
        let mut indices = Vec::with_capacity(axes);
        for dictionary in &dictionaries {
            let width = index_width(dictionary.len());
            let bytes = reader.take(count * width)?;
            let axis: Vec<u32> = match width {
                1 => bytes.iter().map(|&index| u32::from(index)).collect(),
                2 => bytes
                    .chunks_exact(2)
                    .map(|index| u32::from(u16::from_le_bytes([index[0], index[1]])))
                    .collect(),
                _ => bytes
                    .chunks_exact(4)
                    .map(|index| u32::from_le_bytes([index[0], index[1], index[2], index[3]]))
                    .collect(),
            };
            if axis.iter().any(|&index| index as usize >= dictionary.len()) {
                return Err(damaged("a cell lies on a key it does not have"));
            }
            indices.push(axis);
        }
        let values_at = reader.read;
        Ok(Chunk {
            kind,
            count,
            dictionaries,
            indices,
            decompressed,
            values_at,
        })
    }

    fn values(&self) -> &[u8] {
        &self.decompressed[self.values_at..]
    }

    /// The values of the cells, `width` bytes each.
    fn fixed_values(&self, width: usize) -> Result<std::slice::ChunksExact<'_, u8>, EngineError> {
        let values = self.values();
        if values.len() != self.count * width {
            return Err(damaged("its values do not fit its cells"));
        }
        Ok(values.chunks_exact(width))
    }
}

/// Where the cells of an input line item are, and what a stored cell must be to be one of them.
struct Target<'a> {
    kind: Kind,
    shape: Shape,
    /// For each axis, the position of what lies at it, by key.
    positions: Vec<HashMap<u128, u32>>,
    /// The list of an item-valued line item.
    list: Option<&'a List>,
    /// How many periods a period-valued line item can hold.
    periods: u32,
}

impl<'a> Target<'a> {
    fn new(
        structure: &'a Structure,
        line_item: &LineItem,
        layout: &Layout,
    ) -> Result<Target<'a>, EngineError> {
        let shape = structure.shape_of(layout)?;
        let positions = layout
            .axes
            .iter()
            .map(|axis| {
                let keys = structure.axis_keys(axis, layout.restriction.as_deref())?;
                Ok(keys
                    .iter()
                    .enumerate()
                    .filter_map(|(position, key)| key.map(|key| (key, position as u32)))
                    .collect())
            })
            .collect::<Result<Vec<_>, EngineError>>()?;
        let ty = line_item.format.value_type();
        Ok(Target {
            kind: Kind::of(&ty),
            shape,
            positions,
            list: match ty {
                ValueType::Item(list) => structure.list(list),
                _ => None,
            },
            periods: match ty {
                ValueType::Period(level) => structure.calendar.periods(level),
                _ => 0,
            },
        })
    }

    /// Writes the cells of `chunk` that belong here into `column` and returns how many it
    /// left out.
    fn load(&self, chunk: &Chunk, column: &mut Column) -> Result<usize, EngineError> {
        if chunk.kind != self.kind || chunk.dictionaries.len() != self.positions.len() {
            return Ok(chunk.count);
        }
        let mut cells = vec![0usize; chunk.count];
        for (axis, (dictionary, indices)) in
            chunk.dictionaries.iter().zip(&chunk.indices).enumerate()
        {
            let found: Vec<Option<u32>> = dictionary
                .iter()
                .map(|key| self.positions[axis].get(key).copied())
                .collect();
            let stride = self.shape.strides[axis];
            for (cell, &index) in cells.iter_mut().zip(indices) {
                match found[index as usize] {
                    Some(position) if *cell != LEFT_OUT => *cell += position as usize * stride,
                    _ => *cell = LEFT_OUT,
                }
            }
        }
        let mut left_out = cells.iter().filter(|&&cell| cell == LEFT_OUT).count();
        match column {
            Column::Number(stored) => {
                for (&cell, value) in cells.iter().zip(chunk.fixed_values(8)?) {
                    let number = f64::from_le_bytes(value.try_into().expect("numbers are 8 bytes"));
                    if !number.is_finite() {
                        return Err(damaged("a number is not finite"));
                    }
                    if cell != LEFT_OUT {
                        stored[cell] = number;
                    }
                }
            }
            Column::Boolean(stored) => {
                for (&cell, value) in cells.iter().zip(chunk.fixed_values(1)?) {
                    if cell != LEFT_OUT {
                        stored[cell] = value[0] != 0;
                    }
                }
            }
            Column::Text(stored) => {
                let mut reader = Reader {
                    bytes: chunk.values(),
                    read: 0,
                };
                for &cell in &cells {
                    let len = reader.u32()? as usize;
                    let text = std::str::from_utf8(reader.take(len)?)
                        .map_err(|_| damaged("a text is not text"))?;
                    if cell != LEFT_OUT {
                        stored[cell] = text.into();
                    }
                }
                if reader.read != chunk.values().len() {
                    return Err(damaged("its values do not fit its cells"));
                }
            }
            Column::Date(stored) => {
                for (&cell, value) in cells.iter().zip(chunk.fixed_values(4)?) {
                    let days = i32::from_le_bytes(value.try_into().expect("dates are 4 bytes"));
                    if days != BLANK_DATE
                        && days
                            .checked_add(EPOCH_DAYS_FROM_CE)
                            .and_then(NaiveDate::from_num_days_from_ce_opt)
                            .is_none()
                    {
                        return Err(damaged("a date is not a date"));
                    }
                    if cell != LEFT_OUT {
                        stored[cell] = days;
                    }
                }
            }
            Column::Item(stored) => {
                for (&cell, value) in cells.iter().zip(chunk.fixed_values(16)?) {
                    if cell == LEFT_OUT {
                        continue;
                    }
                    let id = ItemId(Uuid::from_u128(le_u128(value)));
                    match self.list.and_then(|list| list.idx(id)) {
                        Some(index) => stored[cell] = index,
                        None => left_out += 1,
                    }
                }
            }
            Column::Period(stored) => {
                for (&cell, value) in cells.iter().zip(chunk.fixed_values(4)?) {
                    if cell == LEFT_OUT {
                        continue;
                    }
                    let index = u32::from_le_bytes(value.try_into().expect("periods are 4 bytes"));
                    if index < self.periods || index == BLANK_PERIOD {
                        stored[cell] = index;
                    } else {
                        left_out += 1;
                    }
                }
            }
        }
        Ok(left_out)
    }
}

/// The cells of one input line item, laid out as the structure now has it, and how many stored
/// cells were left out.
fn load_line_item(
    structure: &Structure,
    line_item: &LineItem,
    mut chunks: Vec<InputChunk>,
) -> Result<(Column, usize), EngineError> {
    let layout = structure.layout(line_item)?;
    let target = Target::new(structure, line_item, &layout)?;
    let mut column = Column::new_blank(&line_item.format.value_type(), target.shape.size());
    chunks.sort_by_key(|chunk| chunk.chunk);
    let mut left_out = 0;
    for chunk in &chunks {
        left_out += target.load(&Chunk::parse(&chunk.data)?, &mut column)?;
    }
    Ok((column, left_out))
}

/// The cells of every input line item of `structure` from `chunks`, and how many stored cells
/// were left out.
fn load_inputs(
    structure: &Structure,
    chunks: Vec<InputChunk>,
) -> Result<(HashMap<LineItemId, Column>, usize), EngineError> {
    let mut by_line_item: HashMap<LineItemId, Vec<InputChunk>> = HashMap::new();
    for chunk in chunks {
        by_line_item.entry(chunk.line_item).or_default().push(chunk);
    }
    let jobs: Vec<(&LineItem, Vec<InputChunk>)> = structure
        .line_items()
        .filter(|line_item| line_item.formula.is_none())
        .map(|line_item| {
            let chunks = by_line_item.remove(&line_item.id).unwrap_or_default();
            (line_item, chunks)
        })
        .collect();
    let loaded: Vec<(LineItemId, Column, usize)> = jobs
        .into_par_iter()
        .map(|(line_item, chunks)| {
            load_line_item(structure, line_item, chunks)
                .map(|(column, left_out)| (line_item.id, column, left_out))
        })
        .collect::<Result<_, _>>()?;
    let mut inputs = HashMap::with_capacity(loaded.len());
    let mut left_out = 0;
    for (id, column, count) in loaded {
        inputs.insert(id, column);
        left_out += count;
    }
    for chunk in by_line_item.into_values().flatten() {
        left_out += Chunk::parse(&chunk.data)?.count;
    }
    Ok((inputs, left_out))
}
