import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect } from "react"
import { describe, expect, it } from "vitest"
import { HeadingFocusProvider } from "@/components/heading-focus-provider"
import { PageHeader } from "@/components/page-header"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useHeadingFocus } from "@/hooks/use-heading-focus"
import { ModuleTitle } from "./module-title"

/** Hands out how to ask what the page's heading is now, without a click that would take the focus off the input. */
function Probe({ onAsk }: { onAsk: (ask: () => HTMLElement | null) => void }) {
  const ask = useHeadingFocus()
  useEffect(() => onAsk(ask))
  return null
}

describe("the title of a module as the heading of its page", () => {
  it("is the heading that focus finds, also while the name is being renamed", async () => {
    const user = userEvent.setup()
    let ask: () => HTMLElement | null = () => null
    render(
      <HeadingFocusProvider>
        <TooltipProvider>
          <PageHeader
            title="Revenue"
            renderTitle={(className, headingRef) => (
              <ModuleTitle
                name="Revenue"
                headingClassName={className}
                headingRef={headingRef}
                locked={false}
                onRename={async () => {}}
              />
            )}
          />
        </TooltipProvider>
        <Probe onAsk={(next) => (ask = next)} />
      </HeadingFocusProvider>,
    )

    expect(ask()).toBe(screen.getByRole("heading", { level: 1, name: "Revenue" }))
    ask()?.focus()
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus()

    await user.click(screen.getByRole("button", { name: "Rename module" }))
    const editing = ask()
    expect(editing).toBe(screen.getByRole("heading", { level: 1, name: "Revenue" }))
    expect(editing).toHaveClass("sr-only")
  })
})
