/** The first stop for the keyboard: it shows itself on focus and jumps past the sidebar and header. */
export function SkipLink({ targetId }: { targetId: string }) {
  return (
    <a
      href={`#${targetId}`}
      // Not a navigation: going to the hash would add a history entry that Back has to undo.
      onClick={(event) => {
        event.preventDefault()
        document.getElementById(targetId)?.focus()
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:ring-[3px] focus:ring-ring/50 focus:outline-none"
    >
      Skip to content
    </a>
  )
}
