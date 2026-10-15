import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/client"
import { ErrorState } from "./error-state"

const error = new ApiError(500, "internal", "The database is starting up.")

describe("ErrorState", () => {
  it("says what went wrong and retries on request", async () => {
    const onRetry = vi.fn()
    const typist = userEvent.setup()
    render(<ErrorState error={error} onRetry={onRetry} />)

    expect(screen.getByRole("alert")).toHaveTextContent("The database is starting up.")
    const retry = screen.getByRole("button", { name: "Retry" })
    await typist.click(retry)

    expect(onRetry).toHaveBeenCalledOnce()
  })
})
