import { Check } from "lucide-react"
import { type KeyboardEvent, useRef, useState } from "react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import type { Direction } from "../core/selection"
import type { ListOption } from "../edit-reference"

export type ListEditorProps = {
  /** Names the list for assistive technology. */
  label: string
  options: readonly ListOption[]
  /** The item the cell holds. */
  current: string | null
  /** The text that opened the editor, when the cell was typed into. */
  initialSearch: string
  /**
   * An item was chosen; `move` is where the selection goes: down for Enter, up for Shift+Enter,
   * right and left for Tab, and none for a click.
   */
  onPick: (id: string, move: Direction | null) => void
  /** Escape. */
  onCancel: () => void
  /** A click or the focus went elsewhere, which is where it stays. */
  onLeave: () => void
}

// Names that start with the search come first, then names and codes that contain it. The first
// keyword is the name, the second the code.
function rank(_value: string, search: string, keywords: string[] = []): number {
  const query = search.trim().toLowerCase()
  if (query === "") {
    return 1
  }
  const [name = "", code = ""] = keywords.map((keyword) => keyword.toLowerCase())
  if (name.startsWith(query) || code === query) {
    return 1
  }
  return name.includes(query) || code.includes(query) ? 0.5 : 0
}

/**
 * The editor of a list cell: a dropdown of the list's items under the cell, searched by name or
 * code. Enter picks the highlighted item, Tab picks it and moves right, Escape gives up.
 */
export function ListEditor({
  label,
  options,
  current,
  initialSearch,
  onPick,
  onCancel,
  onLeave,
}: ListEditorProps) {
  const [search, setSearch] = useState(initialSearch)
  const [highlighted, setHighlighted] = useState(current ?? "")
  // Enter picks through the list's own selection, which does not say how it was made.
  const enterMove = useRef<"up" | "down" | null>(null)

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      enterMove.current = event.shiftKey ? "up" : "down"
      // The list picks while this key is handled, if there is anything to pick; a later pick,
      // with the pointer, must not take the direction of an Enter that found nothing.
      queueMicrotask(() => {
        enterMove.current = null
      })
    }
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      if (highlighted !== "") {
        onPick(highlighted, event.shiftKey ? "left" : "right")
      }
    }
  }

  return (
    <Popover open>
      <PopoverAnchor asChild>
        <div className="size-full ring-2 ring-primary ring-inset" />
      </PopoverAnchor>
      <PopoverContent
        aria-label={`Items for ${label}`}
        align="start"
        sideOffset={2}
        className="w-64 p-0"
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          onCancel()
        }}
        onInteractOutside={onLeave}
        onOpenAutoFocus={(event) => {
          // What was typed to open the editor is in the search box already, and typing goes on
          // after it rather than over it.
          event.preventDefault()
          const search = (event.currentTarget as HTMLElement).querySelector("input")
          search?.focus()
          search?.setSelectionRange(initialSearch.length, initialSearch.length)
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <Command
          label={label}
          filter={rank}
          value={highlighted}
          onValueChange={setHighlighted}
          onKeyDown={handleKeyDown}
        >
          <CommandInput
            aria-label={label}
            placeholder="Search by name or code"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>
              {options.length === 0 ? "This list has no items." : "No matching items."}
            </CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  className="group"
                  value={option.id}
                  keywords={option.code ? [option.name, option.code] : [option.name]}
                  onSelect={() => {
                    const move = enterMove.current
                    enterMove.current = null
                    onPick(option.id, move)
                  }}
                >
                  <span className="flex-1 truncate">{option.name}</span>
                  {option.code && (
                    // The highlighted row is tinted, which the muted text does not read on.
                    <span className="text-xs text-muted-foreground group-data-[selected=true]:text-accent-foreground">
                      {option.code}
                    </span>
                  )}
                  {option.id === current && (
                    <>
                      <Check aria-hidden />
                      <span className="sr-only">Current value</span>
                    </>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
