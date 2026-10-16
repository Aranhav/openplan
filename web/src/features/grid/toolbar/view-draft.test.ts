import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeModule, regionsId } from "@/test/structure"
import type { ViewDefinition } from "../view-types"
import { clearDraft, readDraft, writeDraft } from "./view-draft"
import type { KnownKeys } from "./view-state"

const module = makeModule({ axes: [{ kind: "list", list: regionsId }] })
const view: ViewDefinition = {
  rows: [{ kind: "line_items" }],
  columns: [{ kind: "list", list: regionsId }],
  pages: [],
  hidden: [{ dim: { kind: "list", list: regionsId }, key: "emea" }],
}

// The members and line items the structure has: none, which only an id of a deleted one is judged by.
const known: KnownKeys = { members: new Set(), lineItems: new Set() }

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("a draft", () => {
  it("is kept for a module and a view, and read back", () => {
    writeDraft(module.id, "view-1", view)

    expect(readDraft(module, "view-1", known)).toEqual(view)
    expect(readDraft(module, "view-2", known)).toBeUndefined()
    expect(readDraft({ ...module, id: "other" }, "view-1", known)).toBeUndefined()
  })

  it("is cleared", () => {
    writeDraft(module.id, "view-1", view)
    clearDraft(module.id, "view-1")

    expect(readDraft(module, "view-1", known)).toBeUndefined()
    expect(sessionStorage.length).toBe(0)
  })

  it("is nothing when what was kept is not a view", () => {
    for (const kept of ["not json", "null", "[]", '{"rows":1,"columns":[]}', '{"rows":[],"columns":{}}']) {
      sessionStorage.setItem(`openplan.view-draft.${module.id}.view-1`, kept)

      expect(readDraft(module, "view-1", known)).toBeUndefined()
    }
  })

  it("is nothing when it is not a view of the module any more", () => {
    writeDraft(module.id, "view-1", { ...view, columns: [] })

    expect(readDraft(module, "view-1", known)).toBeUndefined()
  })

  it("is nothing when it names a member that was deleted since", () => {
    const deleted = "0192f3a0-0000-7000-8000-0000000000ff"
    writeDraft(module.id, "view-1", {
      ...view,
      hidden: [{ dim: { kind: "list", list: regionsId }, key: deleted }],
    })

    expect(readDraft(module, "view-1", known)).toBeUndefined()
    expect(
      readDraft(module, "view-1", { members: new Set([deleted]), lineItems: new Set() }),
    ).toBeDefined()
  })

  it("does no harm when the browser will not keep, give or forget one", () => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError")
      })
    }

    expect(() => writeDraft(module.id, "view-1", view)).not.toThrow()
    expect(readDraft(module, "view-1", known)).toBeUndefined()
    expect(() => clearDraft(module.id, "view-1")).not.toThrow()
  })
})
