import type { Direction, Edge } from "./selection"

/** The part of a `KeyboardEvent` the grid reads. */
export type KeyInput = {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  /** True while an input method is composing text; the composition owns every key then. */
  isComposing?: boolean
}

/** `navigate` while cells are selected, `edit` while a cell editor has focus. */
export type KeyMode = "navigate" | "edit"

export type GridCommand =
  /** Not a grid key: leave the event to the browser or the editor. */
  | { type: "none" }
  | { type: "move"; dir: Direction; extend: boolean; jump: boolean }
  | { type: "edge"; edge: Edge; extend: boolean; jump: boolean }
  | { type: "page"; dir: "up" | "down"; extend: boolean }
  | { type: "selectAll" }
  | { type: "selectRow" }
  | { type: "selectColumn" }
  /** Open the editor on the active cell, keeping its value. */
  | { type: "edit" }
  /** Open the editor on the active cell with `text` in place of its value. */
  | { type: "replace"; text: string }
  /** Save the editor's text, close it and move the selection. */
  | { type: "commit"; move: Direction }
  | { type: "cancel" }
  | { type: "toggle" }
  | { type: "clear" }
  | { type: "copy" }
  | { type: "paste" }
  | { type: "fillDown" }
  | { type: "undo" }
  | { type: "redo" }

const NONE: GridCommand = { type: "none" }

const ARROWS = new Map<string, Direction>([
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
])

/**
 * Turns a key press into a grid command. Ctrl and Command are interchangeable, so a shortcut
 * works on every platform. Keys that are not the grid's come back as `none`, and so does every
 * key while an input method is composing; the caller should only prevent the browser default
 * when the command is anything else.
 */
export function resolveKey(event: KeyInput, mode: KeyMode): GridCommand {
  if (event.isComposing) {
    return NONE
  }
  return mode === "edit" ? resolveEditKey(event) : resolveNavigateKey(event)
}

function resolveEditKey(event: KeyInput): GridCommand {
  if (event.key === "Escape") {
    return { type: "cancel" }
  }
  if (hasShortcutModifier(event)) {
    return NONE
  }
  switch (event.key) {
    case "Enter":
      return { type: "commit", move: event.shiftKey ? "up" : "down" }
    case "Tab":
      return { type: "commit", move: event.shiftKey ? "left" : "right" }
    default:
      return NONE
  }
}

function resolveNavigateKey(event: KeyInput): GridCommand {
  const jump = event.ctrlKey || event.metaKey
  const arrow = ARROWS.get(event.key)
  if (arrow) {
    // Alt+Arrow is history navigation in the browser.
    return event.altKey ? NONE : { type: "move", dir: arrow, extend: event.shiftKey, jump }
  }

  const plain = !hasShortcutModifier(event)
  switch (event.key) {
    case "Escape":
      return { type: "cancel" }
    case "Tab":
      return plain
        ? { type: "move", dir: event.shiftKey ? "left" : "right", extend: false, jump: false }
        : NONE
    case "Enter":
      if (!plain) {
        return NONE
      }
      // Shift+Enter moves up, the way Enter moves down after an edit.
      return event.shiftKey
        ? { type: "move", dir: "up", extend: false, jump: false }
        : { type: "edit" }
    case "F2":
      return plain ? { type: "edit" } : NONE
    case " ":
      if (event.altKey) {
        return NONE
      }
      if (event.ctrlKey || event.metaKey) {
        return event.shiftKey ? NONE : { type: "selectColumn" }
      }
      return event.shiftKey ? { type: "selectRow" } : { type: "toggle" }
    case "Delete":
    case "Backspace":
      return plain ? { type: "clear" } : NONE
    case "Home":
    case "End":
      return event.altKey
        ? NONE
        : {
            type: "edge",
            edge: event.key === "Home" ? "home" : "end",
            extend: event.shiftKey,
            jump,
          }
    case "PageUp":
    case "PageDown":
      return plain
        ? { type: "page", dir: event.key === "PageUp" ? "up" : "down", extend: event.shiftKey }
        : NONE
  }

  if (isPrintable(event)) {
    return { type: "replace", text: event.key }
  }
  return jump ? resolveShortcut(event) : NONE
}

function resolveShortcut(event: KeyInput): GridCommand {
  if (event.altKey) {
    return NONE
  }
  const key = event.key.toLowerCase()
  if (event.shiftKey) {
    return key === "z" ? { type: "redo" } : NONE
  }
  switch (key) {
    case "a":
      return { type: "selectAll" }
    case "c":
      return { type: "copy" }
    case "v":
      return { type: "paste" }
    case "d":
      return { type: "fillDown" }
    case "z":
      return { type: "undo" }
    case "y":
      // Command+Y is not redo on a Mac.
      return event.ctrlKey ? { type: "redo" } : NONE
    default:
      return NONE
  }
}

function hasShortcutModifier(event: KeyInput): boolean {
  return event.ctrlKey || event.metaKey || event.altKey
}

/**
 * A key that types a character. Alt is a modifier for characters on a Mac (Option) and on
 * Windows (AltGr reports Ctrl and Alt together), but Alt with a letter, digit or Space is a
 * shortcut, so only the characters those keys cannot be are typed.
 */
function isPrintable(event: KeyInput): boolean {
  if (event.metaKey || Array.from(event.key).length !== 1) {
    return false
  }
  if (event.altKey) {
    return !/^[a-z0-9\s]$/i.test(event.key)
  }
  return !event.ctrlKey
}
