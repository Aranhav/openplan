import { describe, expect, it } from "vitest"
import { ApiError } from "./api/client"
import { shouldRetry } from "./query-client"

function failure(status: number) {
  return new ApiError(status, "internal", "Failed.")
}

describe("shouldRetry", () => {
  it.each([[0], [500], [502], [503]])("retries a status %i failure twice", (status) => {
    expect(shouldRetry(0, failure(status))).toBe(true)
    expect(shouldRetry(1, failure(status))).toBe(true)
    expect(shouldRetry(2, failure(status))).toBe(false)
  })

  it.each([[400], [401], [403], [404], [409], [422], [429]])(
    "does not retry a status %i failure",
    (status) => {
      expect(shouldRetry(0, failure(status))).toBe(false)
    },
  )

  it("retries an unexpected error", () => {
    expect(shouldRetry(0, new TypeError("boom"))).toBe(true)
  })
})
