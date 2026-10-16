import { ArrowDown, ArrowUp } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type { DimensionOption } from "./axes"

interface DimensionPickerProps {
  /** The lists and subsets to choose from. */
  options: DimensionOption[]
  /** The keys of the chosen ones, in order. */
  value: string[]
  onChange: (keys: string[]) => void
  disabled?: boolean
  /** Names the checkboxes to assistive technology, e.g. "Lists and subsets". */
  label: string
  /** What the list of options says when the model has no lists. */
  emptyMessage: string
}

/**
 * Chooses lists and subsets and puts the chosen ones in order. A checkbox list takes them in
 * and out; the chosen ones appear below it in an ordered list whose rows move up and down.
 */
export function DimensionPicker({
  options,
  value,
  onChange,
  disabled,
  label,
  emptyMessage,
}: DimensionPickerProps) {
  const id = useId()
  const optionOf = new Map(options.map((option) => [option.key, option]))
  const chosen = value.flatMap((key) => {
    const option = optionOf.get(key)
    return option ? [option] : []
  })
  // The button that moved a row keeps focus when the row lands somewhere else, or when it has
  // gone as far as it can and the other button takes over.
  const moved = useRef<{ key: string; direction: "up" | "down" }>(undefined)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const [announcement, setAnnouncement] = useState("")

  useEffect(() => {
    const last = moved.current
    moved.current = undefined
    if (last) {
      const other = last.direction === "up" ? "down" : "up"
      const same = buttons.current.get(`${last.key}:${last.direction}`)
      const target = same && !same.disabled ? same : buttons.current.get(`${last.key}:${other}`)
      target?.focus()
    }
  }, [value])

  function toggle(key: string, checked: boolean) {
    onChange(checked ? [...value, key] : value.filter((candidate) => candidate !== key))
  }

  function move(key: string, direction: "up" | "down") {
    const index = value.indexOf(key)
    const target = direction === "up" ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= value.length) {
      return
    }
    const next = [...value]
    next.splice(index, 1)
    next.splice(target, 0, key)
    moved.current = { key, direction }
    onChange(next)
    setAnnouncement(
      `${optionOf.get(key)?.name ?? "Dimension"} moved to position ${target + 1} of ${value.length}.`,
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {options.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <div
          role="group"
          aria-label={label}
          className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-1"
        >
          {options.map((option) => {
            const checkboxId = `${id}-${option.key}`
            return (
              <div
                key={option.key}
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-muted/50"
              >
                <Checkbox
                  id={checkboxId}
                  checked={value.includes(option.key)}
                  disabled={disabled}
                  onCheckedChange={(checked) => toggle(option.key, checked === true)}
                />
                <Label htmlFor={checkboxId} className="flex-1 cursor-pointer gap-2 font-normal">
                  <span className="truncate">{option.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{option.kind}</span>
                </Label>
              </div>
            )
          })}
        </div>
      )}
      {chosen.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p id={`${id}-order`} className="text-xs font-medium text-muted-foreground">
            Order of dimensions
          </p>
          <ol aria-labelledby={`${id}-order`} className="flex flex-col gap-1">
            {chosen.map((option, index) => (
              <li
                key={option.key}
                className="flex items-center gap-2 rounded-md border bg-muted/30 py-1 pr-1 pl-3 text-sm"
              >
                <span
                  aria-hidden
                  className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums"
                >
                  {index + 1}
                </span>
                <span className="flex-1 truncate" title={option.name}>
                  {option.name}
                </span>
                <Button
                  ref={(button) => {
                    if (button) {
                      buttons.current.set(`${option.key}:up`, button)
                    } else {
                      buttons.current.delete(`${option.key}:up`)
                    }
                  }}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${option.name} up`}
                  disabled={disabled || index === 0}
                  onClick={() => move(option.key, "up")}
                >
                  <ArrowUp />
                </Button>
                <Button
                  ref={(button) => {
                    if (button) {
                      buttons.current.set(`${option.key}:down`, button)
                    } else {
                      buttons.current.delete(`${option.key}:down`)
                    }
                  }}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${option.name} down`}
                  disabled={disabled || index === chosen.length - 1}
                  onClick={() => move(option.key, "down")}
                >
                  <ArrowDown />
                </Button>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
