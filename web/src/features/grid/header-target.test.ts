import { describe, expect, it } from "vitest"
import { headerOf } from "./header-target"

function html(markup: string): HTMLElement {
  const host = document.createElement("div")
  host.innerHTML = markup
  return host
}

describe("headerOf", () => {
  it("names the column header a pointer is over, from anywhere inside it", () => {
    const host = html(
      '<div role="columnheader" data-header-axis="column" data-header-level="1" data-header-index="7"><div><span id="in">Q1</span></div></div>',
    )

    expect(headerOf(host.querySelector("#in"))).toEqual({ axis: "column", level: 1, index: 7 })
  })

  it("names the row header with the row it is in", () => {
    const host = html(
      '<div role="row" data-row-index="12"><div role="rowheader" data-header-axis="row" data-header-level="0"><span id="in">EMEA</span></div></div>',
    )

    expect(headerOf(host.querySelector("#in"))).toEqual({ axis: "row", level: 0, index: 12 })
  })

  it("is nothing for a cell", () => {
    const host = html('<div role="gridcell" data-row="1" data-col="2"><span id="in">5</span></div>')

    expect(headerOf(host.querySelector("#in"))).toBeUndefined()
  })

  it("is nothing for a target that is not an element", () => {
    expect(headerOf(null)).toBeUndefined()
    expect(headerOf(window)).toBeUndefined()
  })

  it("is nothing for a row header that is not in a row", () => {
    const host = html(
      '<div data-header-axis="row" data-header-level="0"><span id="in">x</span></div>',
    )

    expect(headerOf(host.querySelector("#in"))).toBeUndefined()
  })
})
