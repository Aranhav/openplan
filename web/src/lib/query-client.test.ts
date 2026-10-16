import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "./api/client"
import { createQueryClient, retryDelay, shouldRetry } from "./query-client"

function failure(status: number, retryAfter?: number) {
  return new ApiError(status, "internal", "Failed.", [], retryAfter)
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

describe("retryDelay", () => {
  it("waits 1 s, then twice as long after each failure, up to 30 s", () => {
    const waits = [0, 1, 2, 3, 4, 5, 6].map((count) => retryDelay(count, failure(500)))

    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000])
  })

  it("waits as long as the server asked in Retry-After", () => {
    const busy = failure(503, 2)

    expect(retryDelay(0, busy)).toBe(2000)
    expect(retryDelay(1, busy)).toBe(2000)
  })

  it("does not wait longer than 30 s, whatever the server asks", () => {
    expect(retryDelay(0, failure(503, 600))).toBe(30_000)
  })

  it("waits as for any failure when the server did not say how long", () => {
    expect(retryDelay(0, new TypeError("boom"))).toBe(1000)
    expect(retryDelay(1, failure(503))).toBe(2000)
  })
})

describe("createQueryClient", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("retries a busy server only after the time it asked for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const queryFn = vi.fn<() => Promise<string>>()
    queryFn.mockRejectedValueOnce(failure(503, 2)).mockResolvedValue("done")
    const answer = createQueryClient().fetchQuery({ queryKey: ["busy"], queryFn })

    await vi.advanceTimersByTimeAsync(1999)
    expect(queryFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(await answer).toBe("done")
    expect(queryFn).toHaveBeenCalledTimes(2)
  })
})
