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
    render(<ErrorState error={error} isFetching={false} onRetry={onRetry} />)

    expect(screen.getByRole("alert")).toHaveTextContent("The database is starting up.")
    const retry = screen.getByRole("button", { name: "Retry" })
    expect(retry.querySelector("svg.animate-spin")).not.toBeInTheDocument()
    await typist.click(retry)

    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("waits for the new attempt: Retry is disabled and spins while the data is fetched again", async () => {
    const onRetry = vi.fn()
    const typist = userEvent.setup()
    render(<ErrorState error={error} isFetching onRetry={onRetry} />)

    const retry = screen.getByRole("button", { name: "Retry" })
    expect(retry).toBeDisabled()
    expect(retry.querySelector("svg.animate-spin")).toBeInTheDocument()
    await typist.click(retry)

    expect(onRetry).not.toHaveBeenCalled()
  })
})
