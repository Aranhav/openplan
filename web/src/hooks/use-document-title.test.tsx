import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useDocumentTitle } from "./use-document-title"

beforeEach(() => {
  document.title = "OpenPlan"
})

describe("useDocumentTitle", () => {
  it("sets the title while mounted and restores the previous one after", () => {
    const { unmount } = renderHook(() => useDocumentTitle("Sign in · OpenPlan"))

    expect(document.title).toBe("Sign in · OpenPlan")

    unmount()

    expect(document.title).toBe("OpenPlan")
  })

  it("follows a changed title", () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: "One" },
    })

    rerender({ title: "Two" })

    expect(document.title).toBe("Two")
  })
})
