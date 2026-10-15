import { describe, expect, it, vi } from "vitest"
import { closeUnlessBusy } from "./close-unless-busy"

describe("closeUnlessBusy", () => {
  it("passes a change of the dialog's open state on while nothing is running", () => {
    const onOpenChange = vi.fn()
    const guarded = closeUnlessBusy(false, onOpenChange)
    guarded(false)
    guarded(true)

    expect(onOpenChange.mock.calls).toEqual([[false], [true]])
  })

  it("swallows it while a request is running", () => {
    const onOpenChange = vi.fn()
    const guarded = closeUnlessBusy(true, onOpenChange)
    guarded(false)

    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
