import { afterEach, describe, expect, it, vi } from "vitest"
import { collapseShortcut, isMac, shortcut } from "./shortcuts"

afterEach(() => {
  vi.restoreAllMocks()
})

function platform(name: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(name)
}

describe("isMac", () => {
  it.each(["MacIntel", "MacPPC", "iPhone", "iPad"])("is true for %s", (name) => {
    platform(name)
    expect(isMac()).toBe(true)
  })

  it.each(["Win32", "Linux x86_64", "", "Android"])("is false for '%s'", (name) => {
    platform(name)
    expect(isMac()).toBe(false)
  })
})

describe("shortcut", () => {
  it("names Ctrl and the key on Windows and Linux", () => {
    platform("Win32")
    expect(shortcut("C")).toBe("Ctrl+C")
    expect(shortcut("D")).toBe("Ctrl+D")
  })

  it("names the Command symbol and the key on a Mac", () => {
    platform("MacIntel")
    expect(shortcut("V")).toBe("⌘V")
  })
})

describe("collapseShortcut", () => {
  it.each([
    ["row", false, "Alt+Shift+←", "⌥⇧←"],
    ["row", true, "Alt+Shift+→", "⌥⇧→"],
    ["column", false, "Alt+Shift+↑", "⌥⇧↑"],
    ["column", true, "Alt+Shift+↓", "⌥⇧↓"],
  ] as const)("names the key that %s collapse (expand: %s)", (axis, expand, other, mac) => {
    platform("Win32")
    expect(collapseShortcut(axis, expand)).toBe(other)
    platform("MacIntel")
    expect(collapseShortcut(axis, expand)).toBe(mac)
  })
})
