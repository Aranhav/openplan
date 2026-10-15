import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DateEditor } from "./date-editor"

function setup(props: Partial<Parameters<typeof DateEditor>[0]> = {}) {
  const onText = vi.fn(() => true)
  const onDate = vi.fn()
  const onCancel = vi.fn()
  const onLeave = vi.fn()
  render(
    <DateEditor
      label="Start, Widget"
      initial="2026-03-15"
      current="2026-03-15"
      onText={onText}
      onDate={onDate}
      onCancel={onCancel}
      onLeave={onLeave}
      {...props}
    />,
  )
  return {
    onText,
    onDate,
    onCancel,
    onLeave,
    input: screen.getByRole("textbox", { name: "Start, Widget" }),
  }
}

describe("DateEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 5, 10, 12) })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows the date as text with the calendar open on its month", () => {
    const { input } = setup()

    expect(input).toHaveFocus()
    expect(input).toHaveValue("2026-03-15")
    expect(screen.getByRole("grid")).toHaveAccessibleName(/March 2026/)
    expect(screen.getByRole("gridcell", { selected: true })).toHaveTextContent("15")
  })

  it("opens on the current month when the cell has no date", () => {
    setup({ initial: "", current: null })

    expect(screen.getByRole("grid")).toHaveAccessibleName(/June 2026/)
  })

  it("picks a day from the calendar", async () => {
    vi.useRealTimers()
    const { onDate, onText } = setup()

    await userEvent.click(screen.getByRole("button", { name: /March 20th, 2026/ }))

    expect(onDate).toHaveBeenCalledExactlyOnceWith("2026-03-20", null)
    expect(onText).not.toHaveBeenCalled()
  })

  it("moves to another month and picks a day there", async () => {
    vi.useRealTimers()
    const { onDate } = setup()

    await userEvent.click(screen.getByRole("button", { name: /next month/i }))
    await userEvent.click(screen.getByRole("button", { name: /April 2nd, 2026/ }))

    expect(onDate).toHaveBeenCalledExactlyOnceWith("2026-04-02", null)
  })

  it("saves typed text with Enter and moves down", async () => {
    vi.useRealTimers()
    const { onText } = setup()

    await userEvent.clear(screen.getByRole("textbox"))
    await userEvent.keyboard("2026-12-31{Enter}")

    expect(onText).toHaveBeenCalledExactlyOnceWith("2026-12-31", "down")
  })

  it("gives up with Escape", async () => {
    vi.useRealTimers()
    const { onCancel, onText, onDate } = setup()

    await userEvent.keyboard("{Escape}")

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onText).not.toHaveBeenCalled()
    expect(onDate).not.toHaveBeenCalled()
  })

  it("moves from the text into the calendar with the down arrow", async () => {
    vi.useRealTimers()
    setup()

    await userEvent.keyboard("{ArrowDown}")

    expect(screen.getByRole("button", { name: /March 15th, 2026/ })).toHaveFocus()
  })

  it("picks the focused day with Enter", async () => {
    vi.useRealTimers()
    const { onDate } = setup()

    await userEvent.keyboard("{ArrowDown}{ArrowRight}{Enter}")

    expect(onDate).toHaveBeenCalledExactlyOnceWith("2026-03-16", null)
  })

  it("does not save or give up while the focus is in the calendar", async () => {
    vi.useRealTimers()
    const { onText, onCancel, onLeave, input } = setup()

    await userEvent.keyboard("{ArrowDown}")

    expect(input).not.toHaveFocus()
    expect(onText).not.toHaveBeenCalled()
    expect(onLeave).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("gives up with Escape inside the calendar too", async () => {
    vi.useRealTimers()
    const { onCancel } = setup()

    await userEvent.keyboard("{ArrowDown}{Escape}")

    expect(onCancel).toHaveBeenCalledOnce()
  })
})

describe("DateEditor leaving", () => {
  it("hands the text over when the focus goes out of the text and the calendar", async () => {
    const { onLeave, onText } = setup()
    const outside = document.createElement("button")
    document.body.append(outside)

    await userEvent.click(outside)

    expect(onLeave).toHaveBeenCalledExactlyOnceWith("2026-03-15")
    expect(onText).not.toHaveBeenCalled()
  })
})
