import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeModule, regionsId } from "@/test/structure"
import type { ViewDefinition } from "../view-types"
import { clearDraft, readDraft, writeDraft } from "./view-draft"

const module = makeModule({ axes: [{ kind: "list", list: regionsId }] })
const view: ViewDefinition = {
  rows: [{ kind: "line_items" }],
  columns: [{ kind: "list", list: regionsId }],
  pages: [],
  hidden: [{ dim: { kind: "list", list: regionsId }, key: "emea" }],
}

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("a draft", () => {
  it("is kept for a module and a view, and read back", () => {
    writeDraft(module.id, "view-1", view)

    expect(readDraft(module, "view-1")).toEqual(view)
    expect(readDraft(module, "view-2")).toBeUndefined()
    expect(readDraft({ ...module, id: "other" }, "view-1")).toBeUndefined()
  })

  it("is cleared", () => {
    writeDraft(module.id, "view-1", view)
    clearDraft(module.id, "view-1")

    expect(readDraft(module, "view-1")).toBeUndefined()
    expect(sessionStorage.length).toBe(0)
  })

  it("is nothing when what was kept is not a view", () => {
    for (const kept of ["not json", "null", "[]", '{"rows":1,"columns":[]}', '{"rows":[],"columns":{}}']) {
      sessionStorage.setItem(`openplan.view-draft.${module.id}.view-1`, kept)

      expect(readDraft(module, "view-1")).toBeUndefined()
    }
  })

  it("is nothing when it is not a view of the module any more", () => {
    writeDraft(module.id, "view-1", { ...view, columns: [] })

    expect(readDraft(module, "view-1")).toBeUndefined()
  })

  it("does no harm when the browser will not keep, give or forget one", () => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError")
      })
    }

    expect(() => writeDraft(module.id, "view-1", view)).not.toThrow()
    expect(readDraft(module, "view-1")).toBeUndefined()
    expect(() => clearDraft(module.id, "view-1")).not.toThrow()
  })
})
