import { useContext } from "react"
import { HeadingContext } from "@/lib/heading-focus"

/** Gives the heading of the page on screen, if it has one that `PageHeader` drew. */
export function useHeadingFocus(): () => HTMLElement | null {
  const target = useContext(HeadingContext)
  return () => target?.get() ?? null
}
