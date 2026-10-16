import { describe, expect, it } from "vitest"
import { member } from "@/test/view-query"
import { rowDimInfo } from "./row-dim-info"

// Every character is 7 px wide, and a text is measured at the semibold weight.
const measure = (text: string, weight: number) => (weight === 600 ? text.length * 7 : 0)

describe("rowDimInfo", () => {
  it("is the depth, the chevron and the width of the widest label", () => {
    const members = [
      member("top", "All regions", { has_children: true }),
      member("emea", "EMEA", { depth: 1, has_children: true }),
      member("uk", "United Kingdom", { depth: 2 }),
      member("fr", "France", { depth: 2 }),
    ]

    expect(rowDimInfo(members, measure)).toEqual({
      maxDepth: 2,
      collapsible: true,
      labelWidth: "United Kingdom".length * 7,
    })
  })

  it("has no chevron or steps for a flat dimension", () => {
    expect(rowDimInfo([member("a", "Alpha"), member("b", "Be")], measure)).toEqual({
      maxDepth: 0,
      collapsible: false,
      labelWidth: 5 * 7,
    })
  })

  it("is empty for a dimension without members", () => {
    expect(rowDimInfo([], measure)).toEqual({ maxDepth: 0, collapsible: false, labelWidth: 0 })
  })

  it("measures only the longest labels of a long list", () => {
    const measured: string[] = []
    const members = Array.from({ length: 500 }, (_, i) => member(`m${i}`, `Item ${"x".repeat(i % 50)}`))

    rowDimInfo(members, (text) => {
      measured.push(text)
      return text.length
    })

    expect(measured.length).toBeLessThanOrEqual(40)
    expect(measured.every((text) => text.length >= "Item ".length + 46)).toBe(true)
  })
})
