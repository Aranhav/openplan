import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useSheetDismiss } from "./use-sheet-dismiss"

function setup(busy = false) {
  const onOpenChange = vi.fn()
  const hook = renderHook(({ busy: running }) => useSheetDismiss(onOpenChange, running), {
    initialProps: { busy },
  })
  return { onOpenChange, ...hook }
}

describe("useSheetDismiss", () => {
  it("closes at once when the form has no edits to lose", () => {
    const { result, onOpenChange } = setup()

    act(() => result.current.dismiss(false))

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(result.current.discard.open).toBe(false)
  })

  it("asks first when the form has edits, and closes only when they are given up", () => {
    const { result, onOpenChange } = setup()
    result.current.dirtyRef.current = true

    act(() => result.current.dismiss(false))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(result.current.discard.open).toBe(true)

    act(() => result.current.discard.onDiscard())
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(result.current.discard.open).toBe(false)
  })

  it("keeps the sheet open when the question is answered with keep editing", () => {
    const { result, onOpenChange } = setup()
    result.current.dirtyRef.current = true
    act(() => result.current.dismiss(false))

    act(() => result.current.discard.onOpenChange(false))

    expect(result.current.discard.open).toBe(false)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("does nothing while a request runs", () => {
    const { result, onOpenChange } = setup(true)
    result.current.dirtyRef.current = true

    act(() => result.current.dismiss(false))

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(result.current.discard.open).toBe(false)
  })

  it("passes opening on", () => {
    const { result, onOpenChange } = setup()
    result.current.dirtyRef.current = true

    act(() => result.current.dismiss(true))

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true)
  })
})
