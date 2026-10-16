import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { HeadingFocusProvider } from "@/components/heading-focus-provider"
import { PageHeader } from "@/components/page-header"
import { useHeadingFocus } from "./use-heading-focus"

/** Shows what the hook gave, and a way to ask again after the page has changed. */
function Probe({ onGet }: { onGet: (heading: HTMLElement | null) => void }) {
  const heading = useHeadingFocus()
  return <button onClick={() => onGet(heading())}>Ask</button>
}

describe("useHeadingFocus", () => {
  it("gives the heading of the page that PageHeader drew, which can take focus", async () => {
    let got: HTMLElement | null = null
    render(
      <HeadingFocusProvider>
        <PageHeader title="Versions" />
        <Probe onGet={(heading) => (got = heading)} />
      </HeadingFocusProvider>,
    )

    await userEvent.click(screen.getByRole("button", { name: "Ask" }))

    expect(got).toBe(screen.getByRole("heading", { level: 1, name: "Versions" }))
    ;(got as HTMLElement | null)?.focus()
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus()
  })

  it("follows the page: the heading of the page that replaced it, and nothing once none is left", async () => {
    let got: HTMLElement | null | undefined
    function Pages() {
      const [page, setPage] = useState<"one" | "two" | "none">("one")
      return (
        <HeadingFocusProvider>
          {page === "one" && <PageHeader title="One" />}
          {page === "two" && <PageHeader title="Two" />}
          <button onClick={() => setPage("two")}>Go to two</button>
          <button onClick={() => setPage("none")}>Leave</button>
          <Probe onGet={(heading) => (got = heading)} />
        </HeadingFocusProvider>
      )
    }
    render(<Pages />)

    await userEvent.click(screen.getByRole("button", { name: "Go to two" }))
    await userEvent.click(screen.getByRole("button", { name: "Ask" }))
    expect(got).toBe(screen.getByRole("heading", { level: 1, name: "Two" }))

    await userEvent.click(screen.getByRole("button", { name: "Leave" }))
    await userEvent.click(screen.getByRole("button", { name: "Ask" }))
    expect(got).toBeNull()
  })

  it("gives the heading that a page draws itself, which is handed the ref to give it by", async () => {
    let got: HTMLElement | null = null
    render(
      <HeadingFocusProvider>
        <PageHeader
          title="Revenue"
          renderTitle={(className, headingRef) => (
            <h1 ref={headingRef} tabIndex={-1} className={className}>
              Revenue, renamed in place
            </h1>
          )}
        />
        <Probe onGet={(heading) => (got = heading)} />
      </HeadingFocusProvider>,
    )

    await userEvent.click(screen.getByRole("button", { name: "Ask" }))

    expect(got).toBe(screen.getByRole("heading", { level: 1, name: "Revenue, renamed in place" }))
  })

  it("gives nothing where there is no page around, such as a component on its own", async () => {
    let got: HTMLElement | null | undefined
    render(
      <>
        <PageHeader title="Alone" />
        <Probe onGet={(heading) => (got = heading)} />
      </>,
    )

    await userEvent.click(screen.getByRole("button", { name: "Ask" }))

    expect(got).toBeNull()
  })
})
