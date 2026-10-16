import { describe, expect, it } from "vitest"
import { countOf, relativeTime } from "./format"

const now = new Date("2026-10-15T12:00:00Z")

function ago(seconds: number) {
  return new Date(now.getTime() - seconds * 1000).toISOString()
}

describe("relativeTime", () => {
  it("says just now for the last minute", () => {
    expect(relativeTime(ago(30), now)).toBe("just now")
    expect(relativeTime(ago(0), now)).toBe("just now")
  })

  it("says just now for a moment ahead, when the clocks disagree a little", () => {
    expect(relativeTime(ago(-20), now)).toBe("just now")
  })

  it("counts minutes", () => {
    expect(relativeTime(ago(60), now)).toBe("1 minute ago")
    expect(relativeTime(ago(5 * 60), now)).toBe("5 minutes ago")
    expect(relativeTime(ago(59 * 60 + 59), now)).toBe("59 minutes ago")
  })

  it("counts hours", () => {
    expect(relativeTime(ago(60 * 60), now)).toBe("1 hour ago")
    expect(relativeTime(ago(2 * 60 * 60), now)).toBe("2 hours ago")
  })

  it("counts days", () => {
    expect(relativeTime(ago(24 * 60 * 60), now)).toBe("yesterday")
    expect(relativeTime(ago(3 * 24 * 60 * 60), now)).toBe("3 days ago")
  })

  it("counts weeks, months and years", () => {
    expect(relativeTime(ago(14 * 24 * 60 * 60), now)).toBe("2 weeks ago")
    expect(relativeTime(ago(65 * 24 * 60 * 60), now)).toBe("2 months ago")
    expect(relativeTime(ago(2 * 365 * 24 * 60 * 60), now)).toBe("2 years ago")
  })

  it("looks ahead too", () => {
    expect(relativeTime(ago(-3 * 60 * 60), now)).toBe("in 3 hours")
  })

  it("does not fail on a timestamp it cannot read", () => {
    expect(relativeTime("not a date", now)).toBe("at an unknown time")
    expect(relativeTime("", now)).toBe("at an unknown time")
  })

  it("compares with the current time when none is given", () => {
    expect(relativeTime(new Date().toISOString())).toBe("just now")
  })
})

describe("countOf", () => {
  it("puts the noun in the plural unless there is one", () => {
    expect(countOf(1, "item")).toBe("1 item")
    expect(countOf(0, "item")).toBe("0 items")
    expect(countOf(2, "child item")).toBe("2 child items")
  })

  it("separates the thousands", () => {
    expect(countOf(60000, "item")).toBe("60,000 items")
  })
})
