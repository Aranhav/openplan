import { describe, expect, it } from "vitest"
import { loginSearch, safeRedirectPath } from "./redirect"

describe("safeRedirectPath", () => {
  it.each([
    ["/"],
    ["/models/42"],
    ["/models/42?tab=sheet#row-3"],
    ["/?tab=plan"],
  ])("keeps the in-app path %s", (path) => {
    expect(safeRedirectPath(path)).toBe(path)
  })

  it.each([
    ["nothing", undefined],
    ["an empty string", ""],
    ["a relative path", "models/42"],
    ["an absolute URL", "https://evil.example/steal"],
    ["a protocol-relative URL", "//evil.example"],
    ["a tab smuggled between the slashes", "/\t/evil.example"],
    ["a newline smuggled between the slashes", "/\n/evil.example"],
    ["a backslash", "/\\evil.example"],
    ["a space", "/models/4 2"],
    ["a control character", "/models/\u0000"],
    ["a javascript URL", "javascript:alert(1)"],
  ])("falls back to home for %s", (_label, target) => {
    expect(safeRedirectPath(target)).toBe("/")
  })
})

describe("loginSearch", () => {
  it("omits the redirect when the user was only going home", () => {
    expect(loginSearch("/")).toEqual({})
  })

  it("remembers any other target", () => {
    expect(loginSearch("/models/42?tab=sheet")).toEqual({ redirect: "/models/42?tab=sheet" })
    expect(loginSearch("/?tab=plan")).toEqual({ redirect: "/?tab=plan" })
  })
})
