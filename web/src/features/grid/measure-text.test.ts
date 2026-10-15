import { describe, expect, it, vi } from "vitest"
import { createTextMeasurer } from "./measure-text"

function fakeContext() {
  const measured: string[] = []
  const context = {
    font: "",
    measureText: vi.fn((text: string) => {
      measured.push(`${context.font}|${text}`)
      return { width: text.length * 7 } as TextMetrics
    }),
  }
  return { context, measured }
}

describe("createTextMeasurer", () => {
  it("measures a text in the cell font at the weight it is drawn in", () => {
    const { context, measured } = fakeContext()
    const measure = createTextMeasurer(
      () => context,
      () => "Inter, sans-serif",
    )

    expect(measure("1,234", 400)).toBe(35)
    expect(measure("1,234", 600)).toBe(35)
    expect(measure("1,234", 700)).toBe(35)
    expect(measured).toEqual([
      "400 14px Inter, sans-serif|1,234",
      "600 14px Inter, sans-serif|1,234",
      "700 14px Inter, sans-serif|1,234",
    ])
  })

  it("asks the canvas once for a text", () => {
    const { context } = fakeContext()
    const measure = createTextMeasurer(
      () => context,
      () => "sans-serif",
    )

    measure("99", 400)
    measure("99", 400)
    measure("99", 400)

    expect(context.measureText).toHaveBeenCalledTimes(1)
  })

  it("estimates when there is no canvas", () => {
    const measure = createTextMeasurer(
      () => null,
      () => "sans-serif",
    )

    expect(measure("12345", 400)).toBe(40)
  })

  it("asks for a context once even when there is none", () => {
    const getContext = vi.fn(() => null)
    const measure = createTextMeasurer(getContext, () => "sans-serif")

    measure("1", 400)
    measure("2", 400)
    measure("3", 400)

    expect(getContext).toHaveBeenCalledTimes(1)
  })

  it("keeps the answers for one weight apart from another", () => {
    const { context } = fakeContext()
    const measure = createTextMeasurer(
      () => context,
      () => "sans-serif",
    )

    measure("99", 400)
    measure("99", 700)
    measure("99", 400)

    expect(context.measureText).toHaveBeenCalledTimes(2)
  })

  it("looks the context and the font family up once", () => {
    const { context } = fakeContext()
    const getContext = vi.fn(() => context)
    const getFamily = vi.fn(() => "sans-serif")
    const measure = createTextMeasurer(getContext, getFamily)

    measure("1", 400)
    measure("2", 600)

    expect(getContext).toHaveBeenCalledTimes(1)
    expect(getFamily).toHaveBeenCalledTimes(1)
  })
})
