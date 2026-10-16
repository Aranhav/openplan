import { describe, expect, it } from "vitest"
import { makeModule } from "@/test/structure"
import { groupModules } from "./modules"

const a = makeModule({ id: "a", name: "A" })
const b = makeModule({ id: "b", name: "B", functional_area: "Sales" })
const c = makeModule({ id: "c", name: "C", functional_area: "finance" })
const d = makeModule({ id: "d", name: "D", functional_area: "Sales" })
const e = makeModule({ id: "e", name: "E", functional_area: "  " })

describe("groupModules", () => {
  it("puts the modules outside any functional area first, as they were", () => {
    expect(groupModules([e, a]).ungrouped).toEqual([e, a])
  })

  it("makes a group of each functional area, in alphabetical order whatever the case", () => {
    expect(groupModules([b, c, d]).areas.map((area) => area.name)).toEqual(["finance", "Sales"])
  })

  it("keeps the modules of an area in the order they came in", () => {
    expect(groupModules([d, a, b]).areas).toEqual([{ name: "Sales", modules: [d, b] }])
  })

  it("is empty without modules", () => {
    expect(groupModules([])).toEqual({ ungrouped: [], areas: [] })
  })
})
