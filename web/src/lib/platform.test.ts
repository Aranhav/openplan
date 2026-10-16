import { afterEach, describe, expect, it, vi } from "vitest"
import { isMac } from "./platform"

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

describe("isMac", () => {
  it.each(["MacIntel", "MacPPC", "iPhone", "iPad"])("is true for the platform %s", (name) => {
    platform(name)
    expect(isMac()).toBe(true)
  })

  it.each(["Win32", "Linux x86_64", "", "Android"])("is false for the platform '%s'", (name) => {
    platform(name)
    expect(isMac()).toBe(false)
  })

  it.each(["macOS", "iOS"])("is true for the user agent data's platform %s", (name) => {
    platform("")
    userAgentPlatform(name)
    expect(isMac()).toBe(true)
  })

  it.each(["Windows", "Linux", "Android", "Chrome OS"])(
    "is false for the user agent data's platform %s",
    (name) => {
      platform("")
      userAgentPlatform(name)
      expect(isMac()).toBe(false)
    },
  )

  it("prefers the user agent data to the platform, which a browser may report as it likes", () => {
    platform("MacIntel")
    userAgentPlatform("Windows")
    expect(isMac()).toBe(false)
    platform("Win32")
    userAgentPlatform("macOS")
    expect(isMac()).toBe(true)
  })

  it.each([undefined, ""])(
    "falls back to the platform when the user agent data has '%s'",
    (name) => {
      userAgentPlatform(name)
      platform("MacIntel")
      expect(isMac()).toBe(true)
      platform("Win32")
      expect(isMac()).toBe(false)
    },
  )
})
