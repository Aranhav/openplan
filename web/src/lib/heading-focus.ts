import { createContext } from "react"

/** Where the heading of the page on screen is kept: what `PageHeader` hands over and `useHeadingFocus` gives back. */
export type HeadingTarget = {
  set: (heading: HTMLElement | null) => void
  get: () => HTMLElement | null
}

export const HeadingContext = createContext<HeadingTarget | null>(null)
