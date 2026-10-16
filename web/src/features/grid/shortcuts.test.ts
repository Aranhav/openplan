import { afterEach, describe, expect, it, vi } from "vitest"
import { collapseShortcut, shortcut } from "./shortcuts"

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, "userAgentData")
})

function platform(name: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(name)
}

function userAgentPlatform(name: string | undefined) {
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: { platform: name },
  })
}

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

  it("follows the user agent data's platform", () => {
    platform("")
    userAgentPlatform("macOS")
    expect(shortcut("C")).toBe("⌘C")
    userAgentPlatform("Linux")
    expect(shortcut("C")).toBe("Ctrl+C")
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
