import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import html from "../../index.html?raw"

const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ""

function systemPrefersDark(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) => ({ matches, media: query }) as unknown as MediaQueryList,
  )
}

function runBeforeReactMounts() {
  new Function(inlineScript)()
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.classList.remove("dark")
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("theme script in index.html", () => {
  it("is an inline script", () => {
    expect(inlineScript).not.toBe("")
  })

  it("applies a stored dark theme", () => {
    window.localStorage.setItem("openplan-theme", "dark")

    runBeforeReactMounts()

    expect(document.documentElement).toHaveClass("dark")
  })

  it("keeps a stored light theme even when the system prefers dark", () => {
    systemPrefersDark(true)
    window.localStorage.setItem("openplan-theme", "light")

    runBeforeReactMounts()

    expect(document.documentElement).not.toHaveClass("dark")
  })

  it.each([["system"], ["purple"], [null]])(
    "follows the system preference when the stored theme is %s",
    (stored) => {
      systemPrefersDark(true)
      if (stored) {
        window.localStorage.setItem("openplan-theme", stored)
      }

      runBeforeReactMounts()

      expect(document.documentElement).toHaveClass("dark")
    },
  )

  it("stays light when the system prefers light", () => {
    runBeforeReactMounts()

    expect(document.documentElement).not.toHaveClass("dark")
  })

  it("falls back to the system preference when storage is unavailable", () => {
    systemPrefersDark(true)
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })

    runBeforeReactMounts()

    expect(document.documentElement).toHaveClass("dark")
  })
})
