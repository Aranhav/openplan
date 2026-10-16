import { describe, expect, it } from "vitest"
import { queryKeys } from "./keys"

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
