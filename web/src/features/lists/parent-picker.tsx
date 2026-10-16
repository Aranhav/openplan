import { Check, ChevronsUpDown, Loader2 } from "lucide-react"
import { type ComponentProps, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { matchesQuery } from "./tree"
import type { ItemDto } from "./types"
import { countOf } from "@/lib/format"

/** The most items offered at once; a parent list can be far longer than a menu can show. */
const MAX_PARENT_OPTIONS = 50

interface ParentPickerProps extends Omit<ComponentProps<typeof Button>, "value" | "onChange"> {
  /** The items of the parent list, in order. */
  parents: ItemDto[]
  /** The name of the parent list. */
  parentList: string
  /** The chosen parent item. */
  selected?: ItemDto
  onChange: (parentId: string) => void
  /** What the button is called to assistive technology, before the parent it shows: "Parent of Paris". */
  label: string
  /**
   * The parent is being saved. The button is marked as unavailable and spins, but stays focusable:
   * a disabled button could not take focus back when the list closes after a choice.
   */
  pending?: boolean
}

/** A button that shows the parent item and opens a searchable list of the parent list's items to change it. */
export function ParentPicker({
  parents,
  parentList,
  selected,
  onChange,
  label,
  pending,
  className,
  ...buttonProps
}: ParentPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const matching = query.trim() ? parents.filter((parent) => matchesQuery(parent, query)) : parents
  const shown = matching.slice(0, MAX_PARENT_OPTIONS)
  // The visible text with nothing chosen; the name starts with it (WCAG 2.5.3).
  const choose = `Choose from ${parentList}`

  return (
    <Popover
      open={open && !pending}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next)
          setQuery("")
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={selected ? `${label}: ${selected.name}` : `${choose}: ${label}`}
          aria-busy={pending || undefined}
          aria-disabled={pending || undefined}
          className={cn(
            "w-full min-w-0 justify-between font-normal aria-disabled:opacity-50",
            className,
          )}
          {...buttonProps}
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected?.name ?? choose}
          </span>
          {pending ? (
            <Loader2 className="animate-spin text-muted-foreground" />
          ) : (
            <ChevronsUpDown className="text-muted-foreground" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={`Items of ${parentList}`} className="w-72 p-0">
        <Command shouldFilter={false} label={`Items of ${parentList}`}>
          <CommandInput
            placeholder={`Find in ${parentList}…`}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No item matches.</CommandEmpty>
            <CommandGroup>
              {shown.map((parent) => (
                <CommandItem
                  key={parent.id}
                  value={parent.id}
                  onSelect={() => {
                    onChange(parent.id)
                    setOpen(false)
                    setQuery("")
                  }}
                >
                  <Check className={cn(parent.id === selected?.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{parent.name}</span>
                  {parent.code && (
                    <span className="ml-auto text-xs text-muted-foreground">{parent.code}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {matching.length > shown.length && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Showing the first {shown.length} of {countOf(matching.length, "item")}. Type to narrow
              them down.
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
