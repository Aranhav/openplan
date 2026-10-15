import { describe, expect, it } from "vitest"
import { resolveKey, type GridCommand, type KeyInput, type KeyMode } from "./keymap"

type Mods = Partial<Omit<KeyInput, "key">>

function resolve(key: string, mode: KeyMode, mods: Mods = {}): GridCommand {
  return resolveKey(
    { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods },
    mode,
  )
}

const navigate = (key: string, mods?: Mods) => resolve(key, "navigate", mods)
const edit = (key: string, mods?: Mods) => resolve(key, "edit", mods)
const none: GridCommand = { type: "none" }

// Windows and Linux use Ctrl, macOS uses Command; every shortcut works with either.
const platforms = [
  { name: "Windows (ctrl)", mod: { ctrlKey: true } },
  { name: "Mac (meta)", mod: { metaKey: true } },
]

describe("resolveKey in navigate mode", () => {
  describe("arrows", () => {
    it.each([
      ["ArrowUp", "up"],
      ["ArrowDown", "down"],
      ["ArrowLeft", "left"],
      ["ArrowRight", "right"],
    ] as const)("%s moves %s", (key, dir) => {
      expect(navigate(key)).toEqual({ type: "move", dir, extend: false, jump: false })
    })

    it("extends with Shift", () => {
      expect(navigate("ArrowDown", { shiftKey: true })).toEqual({
        type: "move",
        dir: "down",
        extend: true,
        jump: false,
      })
    })

    it.each(platforms)("jumps to the edge with $name", ({ mod }) => {
      expect(navigate("ArrowRight", mod)).toEqual({
        type: "move",
        dir: "right",
        extend: false,
        jump: true,
      })
    })

    it.each(platforms)("extends to the edge with Shift and $name", ({ mod }) => {
      expect(navigate("ArrowUp", { ...mod, shiftKey: true })).toEqual({
        type: "move",
        dir: "up",
        extend: true,
        jump: true,
      })
    })

    it("leaves Alt+arrow to the browser (history navigation)", () => {
      expect(navigate("ArrowLeft", { altKey: true })).toEqual(none)
    })
  })

  describe("Tab", () => {
    it("moves right", () => {
      expect(navigate("Tab")).toEqual({ type: "move", dir: "right", extend: false, jump: false })
    })

    it("moves left with Shift", () => {
      expect(navigate("Tab", { shiftKey: true })).toEqual({
        type: "move",
        dir: "left",
        extend: false,
        jump: false,
      })
    })

    it("leaves Ctrl+Tab to the browser", () => {
      expect(navigate("Tab", { ctrlKey: true })).toEqual(none)
    })
  })

  describe("editing keys", () => {
    it("starts editing on Enter and F2", () => {
      expect(navigate("Enter")).toEqual({ type: "edit" })
      expect(navigate("F2")).toEqual({ type: "edit" })
    })

    it("moves up on Shift+Enter, as Excel does", () => {
      expect(navigate("Enter", { shiftKey: true })).toEqual({
        type: "move",
        dir: "up",
        extend: false,
        jump: false,
      })
    })

    it("leaves Enter with Ctrl, Command or Alt alone", () => {
      expect(navigate("Enter", { ctrlKey: true })).toEqual(none)
      expect(navigate("Enter", { metaKey: true, shiftKey: true })).toEqual(none)
      expect(navigate("Enter", { altKey: true })).toEqual(none)
    })

    it("cancels on Escape", () => {
      expect(navigate("Escape")).toEqual({ type: "cancel" })
    })

    it("toggles a boolean on Space", () => {
      expect(navigate(" ")).toEqual({ type: "toggle" })
    })

    it("selects the row on Shift+Space", () => {
      expect(navigate(" ", { shiftKey: true })).toEqual({ type: "selectRow" })
    })

    it.each(platforms)("selects the column on Space with $name", ({ mod }) => {
      expect(navigate(" ", mod)).toEqual({ type: "selectColumn" })
    })

    it.each(platforms)("leaves Shift and $name with Space alone", ({ mod }) => {
      expect(navigate(" ", { ...mod, shiftKey: true })).toEqual(none)
    })

    it("clears on Delete and Backspace", () => {
      expect(navigate("Delete")).toEqual({ type: "clear" })
      expect(navigate("Backspace")).toEqual({ type: "clear" })
    })
  })

  describe("Home, End and paging", () => {
    it("goes to the row edges with Home and End", () => {
      expect(navigate("Home")).toEqual({ type: "edge", edge: "home", extend: false, jump: false })
      expect(navigate("End")).toEqual({ type: "edge", edge: "end", extend: false, jump: false })
    })

    it.each(platforms)("goes to the grid corners with $name", ({ mod }) => {
      expect(navigate("Home", mod)).toEqual({
        type: "edge",
        edge: "home",
        extend: false,
        jump: true,
      })
      expect(navigate("End", mod)).toEqual({
        type: "edge",
        edge: "end",
        extend: false,
        jump: true,
      })
    })

    it("extends with Shift", () => {
      expect(navigate("End", { shiftKey: true, ctrlKey: true })).toEqual({
        type: "edge",
        edge: "end",
        extend: true,
        jump: true,
      })
    })

    it("pages up and down, extending with Shift", () => {
      expect(navigate("PageUp")).toEqual({ type: "page", dir: "up", extend: false })
      expect(navigate("PageDown")).toEqual({ type: "page", dir: "down", extend: false })
      expect(navigate("PageDown", { shiftKey: true })).toEqual({
        type: "page",
        dir: "down",
        extend: true,
      })
    })
  })

  describe.each(platforms)("shortcuts with $name", ({ mod }) => {
    it.each([
      ["a", { type: "selectAll" }],
      ["c", { type: "copy" }],
      ["v", { type: "paste" }],
      ["d", { type: "fillDown" }],
      ["z", { type: "undo" }],
    ] as const)("%s runs %j", (key, command) => {
      expect(navigate(key, mod)).toEqual(command)
    })

    it("accepts capital letters, as with Caps Lock", () => {
      expect(navigate("C", mod)).toEqual({ type: "copy" })
    })

    it("redoes with Shift+Z", () => {
      expect(navigate("Z", { ...mod, shiftKey: true })).toEqual({ type: "redo" })
      expect(navigate("z", { ...mod, shiftKey: true })).toEqual({ type: "redo" })
    })

    it("ignores shortcuts that carry Shift or Alt they do not define", () => {
      expect(navigate("c", { ...mod, shiftKey: true })).toEqual(none)
      expect(navigate("v", { ...mod, altKey: true })).toEqual(none)
      expect(navigate("z", { ...mod, altKey: true })).toEqual(none)
    })

    it("ignores unmapped shortcuts", () => {
      expect(navigate("r", mod)).toEqual(none)
      expect(navigate("x", mod)).toEqual(none)
    })
  })

  it("redoes with Ctrl+Y but not Command+Y", () => {
    expect(navigate("y", { ctrlKey: true })).toEqual({ type: "redo" })
    expect(navigate("y", { metaKey: true })).toEqual(none)
  })

  describe("typing", () => {
    it("starts editing and replaces the value with a printable character", () => {
      expect(navigate("a")).toEqual({ type: "replace", text: "a" })
      expect(navigate("7")).toEqual({ type: "replace", text: "7" })
      expect(navigate("-")).toEqual({ type: "replace", text: "-" })
      expect(navigate("(")).toEqual({ type: "replace", text: "(" })
    })

    it("keeps the case Shift produced", () => {
      expect(navigate("A", { shiftKey: true })).toEqual({ type: "replace", text: "A" })
    })

    it("treats characters outside the basic plane as one character", () => {
      expect(navigate("😀")).toEqual({ type: "replace", text: "😀" })
    })

    it("accepts characters made with Option on a Mac", () => {
      expect(navigate("å", { altKey: true })).toEqual({ type: "replace", text: "å" })
    })

    it("accepts characters made with AltGr on Windows, which reports Ctrl and Alt", () => {
      expect(navigate("€", { ctrlKey: true, altKey: true })).toEqual({
        type: "replace",
        text: "€",
      })
    })

    it("does not type a Command shortcut", () => {
      expect(navigate("k", { metaKey: true })).toEqual(none)
    })

    it("does not type Alt with a letter, a digit or Space, which are shortcuts", () => {
      expect(navigate("a", { altKey: true })).toEqual(none)
      expect(navigate("5", { altKey: true })).toEqual(none)
      expect(navigate(" ", { altKey: true })).toEqual(none)
    })

    it.each(["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Process", "F5", "Insert"])(
      "ignores the %s key",
      (key) => {
        expect(navigate(key)).toEqual(none)
      },
    )
  })
})

describe("resolveKey while an input method is composing", () => {
  it("ignores every key in navigate mode", () => {
    for (const key of ["a", "7", "Enter", "Tab", "Escape", "ArrowLeft", " ", "Delete"]) {
      expect(navigate(key, { isComposing: true })).toEqual(none)
    }
    expect(navigate("c", { ctrlKey: true, isComposing: true })).toEqual(none)
  })

  it("ignores every key in edit mode, so Enter only confirms the composition", () => {
    for (const key of ["a", "Enter", "Tab", "Escape"]) {
      expect(edit(key, { isComposing: true })).toEqual(none)
    }
  })

  it("reads keys normally once composing is false or absent", () => {
    expect(edit("Enter", { isComposing: false })).toEqual({ type: "commit", move: "down" })
    expect(navigate("a", { isComposing: false })).toEqual({ type: "replace", text: "a" })
  })
})

describe("resolveKey in edit mode", () => {
  it("commits and moves down on Enter and up on Shift+Enter", () => {
    expect(edit("Enter")).toEqual({ type: "commit", move: "down" })
    expect(edit("Enter", { shiftKey: true })).toEqual({ type: "commit", move: "up" })
  })

  it("commits and moves right on Tab and left on Shift+Tab", () => {
    expect(edit("Tab")).toEqual({ type: "commit", move: "right" })
    expect(edit("Tab", { shiftKey: true })).toEqual({ type: "commit", move: "left" })
  })

  it("cancels on Escape", () => {
    expect(edit("Escape")).toEqual({ type: "cancel" })
  })

  it("leaves Enter with Ctrl, Command or Alt to the editor", () => {
    expect(edit("Enter", { ctrlKey: true })).toEqual(none)
    expect(edit("Enter", { metaKey: true })).toEqual(none)
    expect(edit("Enter", { altKey: true })).toEqual(none)
  })

  it.each(platforms)("leaves text shortcuts to the input with $name", ({ mod }) => {
    for (const key of ["a", "c", "v", "d", "z", "y"]) {
      expect(edit(key, mod)).toEqual(none)
    }
    expect(edit("z", { ...mod, shiftKey: true })).toEqual(none)
  })

  it("leaves caret, deletion and typing keys to the input", () => {
    for (const key of [
      "ArrowLeft",
      "ArrowDown",
      "Home",
      "End",
      "PageDown",
      "Delete",
      "Backspace",
      " ",
      "F2",
      "a",
      "7",
    ]) {
      expect(edit(key)).toEqual(none)
    }
  })
})
