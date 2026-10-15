import * as React from "react"

/** Tailwind's `md` and `lg` breakpoints, in px. */
const MD_BREAKPOINT = 768
export const LG_BREAKPOINT = 1024

/** Whether the window is narrower than `breakpoint`; the sidebar's `md` unless told otherwise. */
export function useIsMobile(breakpoint = MD_BREAKPOINT) {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < breakpoint)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < breakpoint)
    return () => mql.removeEventListener("change", onChange)
  }, [breakpoint])

  return !!isMobile
}
