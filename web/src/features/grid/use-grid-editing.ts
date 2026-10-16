import { type RefObject, useEffect, useEffectEvent, useRef, useState } from "react"
import { toast } from "sonner"
import { errorDetail } from "@/lib/api/client"
import { type CellReader, type CellTarget, cellKey, cellTarget } from "./cell-targets"
import { parseTsv, pasteArea, planFillDown, planPaste, toTsv } from "./core/clipboard"
import { copyText, editText } from "./core/format-value"
import type { GridCommand } from "./core/keymap"
import { parseInput } from "./core/parse-value"
import {
  type Bounds,
  type CellRange,
  type Direction,
  type Pos,
  type Selection,
  rangeOf,
} from "./core/selection"
import type { Format, Value } from "./core/types"
import type { CellEdit, Placement } from "./core/undo"
import { type GridReference, displayText, parseContextFor, sameValue } from "./edit-reference"
import { shortcut } from "./shortcuts"
import { type BatchSource, useCellEdits } from "./use-cell-edits"

/** The most cells one paste, fill, clear or copy takes. */
const MAX_CELLS = 10_000

/**
 * What the open editor is for: the cell, the kind of editor and the text it opens with, and
 * whether it was opened by typing over the value (`entered`) rather than on the value.
 */
type EditorState = {
  pos: Pos
  kind: "text" | "list" | "date"
  initial: string
  entered: boolean
}

type Options = {
  modelId: string
  moduleId: string
  /** The key of the query of the view that is shown: the cells' positions are positions in it. */
  view: string
  /** Nothing can be written: a viewer, or a view that is not the current one yet. */
  readOnly: boolean
  reference: GridReference
  selection: Selection
  bounds: Bounds
  /** The cells that have loaded. */
  reader: CellReader
  /** Loads the blocks that hold a range, and answers with what they hold. */
  load: (range: CellRange) => Promise<CellReader>
  /** What `load` would answer if the blocks have loaded already, and nothing if not. */
  peek: (range: CellRange) => CellReader | undefined
  /** Moves the selection one cell, as after an edit. */
  moveSelection: (direction: Direction) => void
  /** Selects a range, with the active cell at its top left, and brings it into view. */
  selectRange: (range: CellRange) => void
  /** Says something politely, to a screen reader. */
  announce: (text: string) => void
  /** The grid, which has the focus: copy, cut and paste are taken from the document while it does. */
  gridRef: RefObject<HTMLElement | null>
  /** Puts the keyboard back on the grid when an editor closes. */
  focusGrid: () => void
}

type Candidate = { target: CellTarget; value: Value }

function cellCount(range: CellRange): number {
  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
}

function cellRange(pos: Pos): CellRange {
  return { rowStart: pos.row, rowEnd: pos.row, colStart: pos.col, colEnd: pos.col }
}

function cells(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "cell" : "cells"}`
}

function readOnlyCells(count: number): string {
  return `${count.toLocaleString("en-US")} read-only ${count === 1 ? "cell" : "cells"}`
}

function skippedNote(skipped: number): string {
  return skipped > 0 ? `, skipped ${readOnlyCells(skipped)}` : ""
}

/** The blank of a format: what clearing a cell leaves. */
function blankOf(format: Format, reference: GridReference): Value {
  const blank = parseInput("", format, parseContextFor(format, reference))
  return blank.ok ? blank.value : { t: "text", v: "" }
}

/** The range that holds every position of a plan. */
function rangeOfPositions(positions: readonly Pos[]): CellRange {
  const first = positions[0]
  const range = {
    rowStart: first.row,
    rowEnd: first.row,
    colStart: first.col,
    colEnd: first.col,
  }
  for (const { row, col } of positions) {
    range.rowStart = Math.min(range.rowStart, row)
    range.rowEnd = Math.max(range.rowEnd, row)
    range.colStart = Math.min(range.colStart, col)
    range.colEnd = Math.max(range.colEnd, col)
  }
  return range
}

/**
 * Everything that changes cells in a grid: the editor on the active cell, the keys that clear,
 * toggle, fill, undo and redo, and the clipboard. Values are parsed here, a batch is refused
 * whole when one of its values is, and what is written goes through `useCellEdits`.
 */
export function useGridEditing({
  modelId,
  moduleId,
  view,
  readOnly,
  reference,
  selection,
  bounds,
  reader,
  load,
  peek,
  moveSelection,
  selectRange,
  announce,
  gridRef,
  focusGrid,
}: Options) {
  // The view that is shown now: undo and redo are taken up once the writes before them are done,
  // and a closure of the render that asked for them would still know the view of then.
  const shown = useRef(view)
  useEffect(() => {
    shown.current = view
  }, [view])

  /** Selects where a batch was made, unless the view changed: its positions are other cells. */
  function selectPlacement(where: Placement) {
    if (where.view === shown.current) {
      selectRange(where.range)
    }
  }

  const edits = useCellEdits(modelId, moduleId, {
    // Undo and redo show what they changed.
    onReplay: selectPlacement,
    // A paste and a fill say what they did, and a refusal has its toast; one cell saved is said here.
    onSaved: (count, source) => {
      if (count === 1 && source !== "paste" && source !== "fill") {
        announce("Saved")
      }
    },
  })
  const { pending } = edits
  const [editor, setEditor] = useState<EditorState | null>(null)
  const active = selection.anchor

  /** What a cell holds, counting an edit that is still being written. */
  function effective(target: CellTarget): { value: Value; text: string | undefined } {
    const value = target.coords && pending.get(cellKey(target.lineItem.id, target.coords))
    return value
      ? { value, text: displayText(value, target.lineItem.format, reference) }
      : { value: target.cell.value, text: target.cell.text }
  }

  /** The edit that sets a cell to `value`, unless it holds that already. */
  function changeOf(target: CellTarget, value: Value): CellEdit | undefined {
    const before = effective(target).value
    if (!target.coords || sameValue(before, value)) {
      return undefined
    }
    return { lineItemId: target.lineItem.id, coords: target.coords, before, after: value }
  }

  /** What a cell copies as: nothing for a cell that does not apply or is in error. */
  function copiedText(target: CellTarget): string {
    if (target.cell.flags.includes("na") || target.cell.flags.includes("error")) {
      return ""
    }
    const shown = effective(target)
    return copyText(shown.value, target.lineItem.format, shown.text)
  }

  /** Writes what differs from what the cells hold; `where` is what undo and redo select. */
  function write(
    candidates: readonly Candidate[],
    where: CellRange,
    source: BatchSource = "edit",
  ): Promise<boolean> {
    const changes = candidates.flatMap(({ target, value }) => changeOf(target, value) ?? [])
    return edits.commit(changes, { range: where, view }, source)
  }

  function toggle(target: CellTarget, pos: Pos) {
    const current = effective(target).value
    if (current.t === "boolean") {
      void write([{ target, value: { t: "boolean", v: !current.v } }], cellRange(pos))
    }
  }

  /** The cell that can be written at a position, if there is one. */
  function writable(pos: Pos): CellTarget | undefined {
    const target = cellTarget(reader, pos.row, pos.col)
    return !readOnly && target?.editable ? target : undefined
  }

  function open(pos: Pos, typed?: string) {
    const target = writable(pos)
    if (!target) {
      return
    }
    const { format } = target.lineItem
    if (format.type === "boolean") {
      // A check box takes no typing, only a toggle.
      if (typed === undefined) {
        toggle(target, pos)
      }
      return
    }
    const shown = effective(target)
    setEditor({
      pos,
      kind: format.type === "list" ? "list" : format.type === "date" ? "date" : "text",
      initial: typed ?? (format.type === "list" ? "" : editText(shown.value, format, shown.text)),
      entered: typed !== undefined,
    })
  }

  function close(move: Direction | null, refocus: boolean) {
    setEditor(null)
    if (refocus) {
      focusGrid()
    }
    if (move) {
      moveSelection(move)
    }
  }

  /** Saves typed text into the cell being edited; answers whether the text was taken. */
  function saveText(text: string, move: Direction | null, refocus: boolean): boolean {
    if (!editor) {
      return true
    }
    const target = writable(editor.pos)
    if (target) {
      const { format } = target.lineItem
      const parsed = parseInput(text, format, parseContextFor(format, reference))
      if (!parsed.ok) {
        toast.error(parsed.message)
        return false
      }
      void write([{ target, value: parsed.value }], cellRange(editor.pos))
    }
    close(move, refocus)
    return true
  }

  const editing = {
    editor,
    commitText: (text: string, move: Direction) => saveText(text, move, true),
    /** The focus went elsewhere: the text is saved if it is a value, and either way it is over. */
    leave: (text: string) => {
      if (editor?.kind === "list" || !saveText(text, null, false)) {
        close(null, false)
      }
    },
    cancel: () => close(null, true),
    /** A value chosen in a list or a calendar. */
    pick: (value: Value, move: Direction | null) => {
      const target = editor && writable(editor.pos)
      if (target) {
        void write([{ target, value }], cellRange(editor.pos))
      }
      close(move, true)
    },
  }

  async function readCells(range: CellRange): Promise<CellReader | undefined> {
    try {
      return await load(range)
    } catch (error) {
      toast.error(errorDetail(error))
      return undefined
    }
  }

  async function clear() {
    const range = rangeOf(selection)
    if (readOnly) {
      return
    }
    if (cellCount(range) > MAX_CELLS) {
      toast.error("Select at most 10,000 cells to change at once.")
      return
    }
    const loaded = await readCells(range)
    if (!loaded) {
      return
    }
    const candidates: Candidate[] = []
    for (let row = range.rowStart; row <= range.rowEnd; row++) {
      for (let col = range.colStart; col <= range.colEnd; col++) {
        const target = cellTarget(loaded, row, col)
        if (target?.editable) {
          candidates.push({ target, value: blankOf(target.lineItem.format, reference) })
        }
      }
    }
    await write(candidates, range)
  }

  async function fillDown() {
    const range = rangeOf(selection)
    if (readOnly) {
      return
    }
    if (cellCount(range) > MAX_CELLS) {
      toast.error("Select at most 10,000 cells to change at once.")
      return
    }
    const plan = planFillDown(selection)
    if (plan.length === 0) {
      return
    }
    // A single row copies the row above it, which may not be loaded.
    const loaded = await readCells({ ...range, rowStart: Math.max(range.rowStart - 1, 0) })
    if (!loaded) {
      return
    }
    const candidates: Candidate[] = []
    let skipped = 0
    for (const { from, to } of plan) {
      const source = cellTarget(loaded, from.row, from.col)
      const target = cellTarget(loaded, to.row, to.col)
      if (!source || !target) {
        toast.error("Couldn't read the cells to fill. Try again in a moment.")
        return
      }
      if (!target.editable) {
        skipped++
        continue
      }
      const raw = copiedText(source)
      const { format } = target.lineItem
      const parsed = parseInput(raw, format, parseContextFor(format, reference))
      if (!parsed.ok) {
        const where = `Row ${to.row - range.rowStart + 1}, column ${to.col - range.colStart + 1}`
        toast.error(`${where}: ${parsed.message}`)
        return
      }
      candidates.push({ target, value: parsed.value })
    }
    if (await write(candidates, range, "fill")) {
      if (skipped > 0) {
        toast.success(`Filled ${cells(candidates.length)}${skippedNote(skipped)}`)
      } else {
        // A fill that skipped nothing has no toast, and is not announced as a save either.
        announce(`Filled ${cells(candidates.length)}`)
      }
    }
  }

  async function pasteText(text: string) {
    if (readOnly) {
      return
    }
    // Only what can land is read: the rest of a long clipboard is not needed to refuse it.
    const start = rangeOf(selection)
    const block = parseTsv(text, {
      rows: Math.min(bounds.rows - start.rowStart, MAX_CELLS + 1),
      cols: Math.min(bounds.cols - start.colStart, MAX_CELLS + 1),
    })
    if (block.length === 0) {
      return
    }
    if (pasteArea(block, selection, bounds) > MAX_CELLS) {
      toast.error("Select or paste at most 10,000 cells at a time.")
      return
    }
    const plan = planPaste(block, selection, bounds)
    if (plan.length === 0) {
      return
    }
    const pasted = rangeOfPositions(plan.map((edit) => edit.pos))
    const loaded = await readCells(pasted)
    if (!loaded) {
      return
    }
    const width = block.reduce((widest, row) => Math.max(widest, row.length), 0)
    const candidates: Candidate[] = []
    let skipped = 0
    for (const { pos, raw } of plan) {
      const target = cellTarget(loaded, pos.row, pos.col)
      if (!target) {
        toast.error("Couldn't read the cells to paste into. Try again in a moment.")
        return
      }
      if (!target.editable) {
        skipped++
        continue
      }
      const { format } = target.lineItem
      const parsed = parseInput(raw, format, parseContextFor(format, reference))
      if (!parsed.ok) {
        // Where the value is in the pasted block, which a repeated block starts over in.
        const row = ((pos.row - start.rowStart) % block.length) + 1
        const col = ((pos.col - start.colStart) % width) + 1
        toast.error(`Row ${row}, column ${col}: ${parsed.message}`)
        return
      }
      candidates.push({ target, value: parsed.value })
    }
    // The pasted cells are selected, with the active cell at the top left, once it is known that
    // every value fits.
    selectPlacement({ range: pasted, view })
    if (await write(candidates, pasted, "paste")) {
      toast.success(`Pasted ${cells(candidates.length)}${skippedNote(skipped)}`)
    }
  }

  /** The text of the cells of a range, or nothing if one of them has not loaded. */
  function textOfCells(source: CellReader, range: CellRange): string[][] | undefined {
    const rows: string[][] = []
    for (let row = range.rowStart; row <= range.rowEnd; row++) {
      const line: string[] = []
      for (let col = range.colStart; col <= range.colEnd; col++) {
        const target = cellTarget(source, row, col)
        if (!target) {
          return undefined
        }
        line.push(copiedText(target))
      }
      rows.push(line)
    }
    return rows
  }

  /** The selection as tab-separated text, or nothing (with a toast) when it cannot be read. */
  function selectionText(): string | undefined {
    const range = rangeOf(selection)
    if (cellCount(range) > MAX_CELLS) {
      toast.error("Select at most 10,000 cells to copy.")
      return undefined
    }
    // The text is needed at once, so the blocks must have loaded already: a selection can reach
    // well past what is on screen. The cells on show come first, since they are the ones that
    // are being read again after an edit, with the edit on top; a block that is not on show and
    // was invalidated is not used, and loading it makes the next try work.
    const source = peek(range)
    const rows = (source && textOfCells(source, range)) ?? textOfCells(reader, range)
    if (!rows) {
      toast.error("Some of the selected cells haven't loaded yet. Try copying again in a moment.")
      void load(range).catch(() => undefined)
      return undefined
    }
    return toTsv(rows)
  }

  // Copy, cut and paste arrive as the browser's own events, which hand over the clipboard without
  // a permission prompt. They are taken from the document while the grid itself has the focus (so
  // an editor, a menu or any other control keeps its own), since a browser sends them to wherever
  // the page's text selection is, which is somewhere else once an editor has closed.
  const copyEvent = useEffectEvent((event: ClipboardEvent) => {
    event.preventDefault()
    const text = selectionText()
    if (text !== undefined) {
      event.clipboardData?.setData("text/plain", text)
    }
  })
  const cutEvent = useEffectEvent((event: ClipboardEvent) => {
    if (readOnly) {
      return
    }
    event.preventDefault()
    const text = selectionText()
    if (text !== undefined) {
      event.clipboardData?.setData("text/plain", text)
      void clear()
    }
  })
  const pasteEvent = useEffectEvent((event: ClipboardEvent) => {
    event.preventDefault()
    void pasteText(event.clipboardData?.getData("text/plain") ?? "")
  })
  useEffect(() => {
    const handlers = { copy: copyEvent, cut: cutEvent, paste: pasteEvent }
    const removers = (["copy", "cut", "paste"] as const).map((type) => {
      const listener = (event: ClipboardEvent) => {
        if (gridRef.current && document.activeElement === gridRef.current) {
          handlers[type](event)
        }
      }
      document.addEventListener(type, listener)
      return () => document.removeEventListener(type, listener)
    })
    return () => removers.forEach((remove) => remove())
  }, [gridRef])

  return {
    ...editing,
    /** What a cell holds now, counting an edit that is still being written. */
    valueOf: effective,
    pendingAt(row: number, col: number): Value | undefined {
      if (pending.size === 0) {
        return undefined
      }
      const target = cellTarget(reader, row, col)
      return target?.coords && pending.get(cellKey(target.lineItem.id, target.coords))
    },
    /** Opens the editor on a cell, as a double click does; a check box is only toggled by a click. */
    openAt: (pos: Pos) => {
      if (cellTarget(reader, pos.row, pos.col)?.lineItem.format.type !== "boolean") {
        open(pos)
      }
    },
    /** Toggles the check box of a cell. */
    toggleAt: (pos: Pos) => {
      const target = writable(pos)
      if (target?.lineItem.format.type === "boolean") {
        toggle(target, pos)
      }
    },
    /** Runs a command that is not about moving the selection; answers whether it was one. */
    run(command: GridCommand): boolean {
      switch (command.type) {
        case "edit":
          open(active)
          return true
        case "replace":
          open(active, command.text)
          return true
        case "toggle": {
          const target = writable(active)
          if (target?.lineItem.format.type === "boolean") {
            toggle(target, active)
          }
          return true
        }
        case "clear":
          void clear()
          return true
        case "fillDown":
          void fillDown()
          return true
        case "undo":
          if (!readOnly) {
            void edits.undo()
          }
          return true
        case "redo":
          if (!readOnly) {
            void edits.redo()
          }
          return true
        case "cancel":
          return true
        default:
          return false
      }
    },
    /** For the menu: Copy where the keys cannot be used. */
    async copyToClipboard() {
      const text = selectionText()
      if (text === undefined) {
        return
      }
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        toast.error(`Your browser blocked copying. Press ${shortcut("C")} instead.`)
      }
    },
    async pasteFromClipboard() {
      let text: string
      try {
        text = await navigator.clipboard.readText()
      } catch {
        toast.error(`Your browser blocked reading the clipboard. Press ${shortcut("V")} instead.`)
        return
      }
      await pasteText(text)
    },
    fillDown,
    /** For the menu: what the active cell and the selection allow. */
    menuState() {
      const range = rangeOf(selection)
      return {
        canPaste: writable(active) !== undefined,
        canFill: !readOnly && (range.rowStart !== range.rowEnd || range.rowStart > 0),
      }
    },
  }
}
