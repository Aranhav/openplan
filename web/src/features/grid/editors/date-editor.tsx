import { useRef } from "react"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import type { Direction } from "../core/selection"
import { TextEditor } from "./text-editor"

export type DateEditorProps = {
  label: string
  /** The date as text, which is what the input opens with. */
  initial: string
  /** The date the cell holds as yyyy-mm-dd, which the calendar opens on. */
  current: string | null
  /** Typed text was entered; answers whether it was taken (see `TextEditor`). */
  onText: (text: string, move: Direction) => boolean
  /** A day was picked in the calendar, as yyyy-mm-dd. */
  onDate: (date: string, move: Direction | null) => void
  /** Escape. */
  onCancel: () => void
  /** The focus went out of the text and the calendar, which is where it stays. */
  onLeave: (text: string) => void
}

/** A day of the calendar from yyyy-mm-dd, on the viewer's calendar rather than in UTC. */
function dayOf(iso: string | null): Date | undefined {
  const match = iso === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) {
    return undefined
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? undefined : date
}

function isoOf(day: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  return `${pad(day.getFullYear(), 4)}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/**
 * The editor of a date cell: the date as text, to type over, with a calendar under it to pick a
 * day from. The down arrow moves from the text into the calendar.
 */
export function DateEditor({
  label,
  initial,
  current,
  onText,
  onDate,
  onCancel,
  onLeave,
}: DateEditorProps) {
  const calendar = useRef<HTMLDivElement>(null)
  const selected = dayOf(current)

  return (
    <Popover open>
      <PopoverAnchor asChild>
        <div className="size-full">
          <TextEditor
            label={label}
            initial={initial}
            align="left"
            onCommit={onText}
            onCancel={onCancel}
            onLeave={onLeave}
            keepOpenFor={(target) => target instanceof Node && !!calendar.current?.contains(target)}
            onKey={(event) => {
              if (event.key !== "ArrowDown" || event.altKey || event.ctrlKey || event.metaKey) {
                return false
              }
              event.preventDefault()
              calendar.current?.querySelector<HTMLElement>('button[tabindex="0"]')?.focus()
              return true
            }}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={calendar}
        align="start"
        sideOffset={2}
        className="w-auto p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // In the text, Escape is the text editor's.
          event.preventDefault()
          if (event.target instanceof Node && calendar.current?.contains(event.target)) {
            onCancel()
          }
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(day) => day && onDate(isoOf(day), null)}
        />
      </PopoverContent>
    </Popover>
  )
}
