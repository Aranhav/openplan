import { Check, ChevronsUpDown } from "lucide-react"
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
import { countOf } from "./words"

/** The most items offered at once; a parent list can be far longer than a menu can show. */
export const MAX_PARENT_OPTIONS = 50

interface ParentPickerProps extends Omit<ComponentProps<typeof Button>, "value" | "onChange"> {
  /** The items of the parent list, in order. */
  parents: ItemDto[]
  /** The name of the parent list. */
  parentList: string
  /** The id of the chosen parent item. */
  value?: string
  onChange: (parentId: string) => void
  /** What the button is called to assistive technology, before the parent it shows: "Parent of Paris". */
  label: string
}

/** A button that shows the parent item and opens a searchable list of the parent list's items to change it. */
export function ParentPicker({
  parents,
  parentList,
  value,
  onChange,
  label,
  className,
  ...buttonProps
}: ParentPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const chosen = parents.find((parent) => parent.id === value)
  const matching = query.trim() ? parents.filter((parent) => matchesQuery(parent, query)) : parents
  const shown = matching.slice(0, MAX_PARENT_OPTIONS)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setQuery("")
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={`${label}: ${chosen?.name ?? "none chosen"}`}
          className={cn("w-full min-w-0 justify-between font-normal", className)}
          {...buttonProps}
        >
          <span className={cn("truncate", !chosen && "text-muted-foreground")}>
            {chosen?.name ?? `Choose from ${parentList}`}
          </span>
          <ChevronsUpDown className="text-muted-foreground" />
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
                  <Check className={cn(parent.id === value ? "opacity-100" : "opacity-0")} />
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
