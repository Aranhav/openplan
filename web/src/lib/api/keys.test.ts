import { describe, expect, it } from "vitest"
import { pivotOfKey, queryKeys } from "./keys"

describe("queryKeys.query", () => {
  it("starts with the model's key, so invalidating a model reaches its queries", () => {
    expect(queryKeys.query("m1").slice(0, queryKeys.model("m1").length)).toEqual(
      queryKeys.model("m1"),
    )
  })

  it("is a prefix of every query of the model", () => {
    const block = { rowBlock: 0, colBlock: 1 }

    expect(queryKeys.query("m1")).toEqual(["models", "m1", "query"])
    expect(queryKeys.query("m1", "pivot", block)).toEqual(["models", "m1", "query", "pivot", block])
  })
})

describe("queryKeys.structure", () => {
  it("sits under the model's key and apart from the grid queries", () => {
    expect(queryKeys.structure("m1")).toEqual(["models", "m1", "structure"])
    expect(queryKeys.structure("m1").slice(0, queryKeys.model("m1").length)).toEqual(
      queryKeys.model("m1"),
    )
    expect(queryKeys.structure("m1").slice(0, queryKeys.query("m1").length)).not.toEqual(
      queryKeys.query("m1"),
    )
  })
})

describe("queryKeys.formulaCompletions", () => {
  it("sits under the structure's key, so a change to the structure makes what was offered stale", () => {
    const key = queryKeys.formulaCompletions("m1", "li1", "Rev")

    expect(key.slice(0, queryKeys.structure("m1").length)).toEqual(queryKeys.structure("m1"))
    expect(key).not.toEqual(queryKeys.formulaCompletions("m1", "li1", "Re"))
    expect(key).not.toEqual(queryKeys.formulaCompletions("m1", "li2", "Rev"))
  })
})

describe("pivotOfKey", () => {
  it("finds the pivot of a view", () => {
    const pivot = { module: "mod", rows: [], columns: [] }

    expect(pivotOfKey(queryKeys.query("m1", pivot, { rowBlock: 0, colBlock: 0 }))).toBe(pivot)
    expect(pivotOfKey(queryKeys.query("m1"))).toBeUndefined()
  })
})
