import { type ReactNode, useState } from "react"
import { HeadingContext, type HeadingTarget } from "@/lib/heading-focus"

function createTarget(): HeadingTarget {
  let heading: HTMLElement | null = null
  return {
    set: (next) => {
      heading = next
    },
    get: () => heading,
  }
}

/**
 * Around the pages of the app, so that the heading of the page on screen can be found without
 * searching the document for it: `PageHeader` hands its heading to it, and `useHeadingFocus`
 * gives it back to code that must put focus somewhere when what it meant to focus is gone.
 */
export function HeadingFocusProvider({ children }: { children: ReactNode }) {
  const [target] = useState(createTarget)
  return <HeadingContext value={target}>{children}</HeadingContext>
}
