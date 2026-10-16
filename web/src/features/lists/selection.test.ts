import { describe, expect, it } from "vitest"
import { sameIds, withIds } from "./selection"

describe("a set of ids with some added or taken out", () => {
  it("is a copy, and leaves the set it was made from alone", () => {
    const before = new Set(["a", "b"])
    const added = withIds(before, ["b", "c"], true)
    const removed = withIds(before, ["a", "x"], false)

    expect([...added]).toEqual(["a", "b", "c"])
    expect([...removed]).toEqual(["b"])
    expect([...before]).toEqual(["a", "b"])
  })
})

describe("comparing a set of ids", () => {
  it("ignores the order and counts a repeat once", () => {
    expect(sameIds(new Set(["a", "b"]), ["b", "a", "b"])).toBe(true)
    expect(sameIds(new Set(["a", "b"]), ["a"])).toBe(false)
    expect(sameIds(new Set(["a"]), ["a", "b"])).toBe(false)
    expect(sameIds(new Set(), [])).toBe(true)
  })
})
