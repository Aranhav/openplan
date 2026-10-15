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
  it("measures a text in the cell font, bold or not", () => {
    const { context, measured } = fakeContext()
    const measure = createTextMeasurer(
      () => context,
      () => "Inter, sans-serif",
    )

    expect(measure("1,234", false)).toBe(35)
    expect(measure("1,234", true)).toBe(35)
    expect(measured).toEqual([
      "400 14px Inter, sans-serif|1,234",
      "600 14px Inter, sans-serif|1,234",
    ])
  })

  it("asks the canvas once for a text", () => {
    const { context } = fakeContext()
    const measure = createTextMeasurer(
      () => context,
      () => "sans-serif",
    )

    measure("99", false)
    measure("99", false)
    measure("99", false)

    expect(context.measureText).toHaveBeenCalledTimes(1)
  })

  it("estimates when there is no canvas", () => {
    const measure = createTextMeasurer(
      () => null,
      () => "sans-serif",
    )

    expect(measure("12345", false)).toBe(40)
  })

  it("looks the context and the font family up once", () => {
    const { context } = fakeContext()
    const getContext = vi.fn(() => context)
    const getFamily = vi.fn(() => "sans-serif")
    const measure = createTextMeasurer(getContext, getFamily)

    measure("1", false)
    measure("2", true)

    expect(getContext).toHaveBeenCalledTimes(1)
    expect(getFamily).toHaveBeenCalledTimes(1)
  })
})
