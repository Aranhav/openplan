import { type KeyboardEvent, useCallback, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { keyInput, resolveKey } from "../core/keymap"
import type { Direction } from "../core/selection"

export type TextEditorProps = {
  /** What the editor opens with, the caret after it. */
  initial: string
  /** Names the input for assistive technology. */
  label: string
  align: "left" | "right"
  /**
   * The editor was opened by typing over the value, so the arrow keys save and move on, as in
   * Excel, until F2 switches to editing the value, where they move the caret. Opened on the
   * value (F2, Enter, a double click) it is the other way round.
   */
  entered?: boolean
  /** Enter or Tab: saves the text and moves the selection. Answers whether the text was taken. */
  onCommit: (text: string, move: Direction) => boolean
  /** Escape. */
  onCancel: () => void
  /**
   * The focus went elsewhere, which is where it stays: the text is saved or refused, and either
   * way the editor is done.
   */
  onLeave: (text: string) => void
  /** Sees every key first and answers true for one it has taken. */
  onKey?: (event: KeyboardEvent<HTMLInputElement>) => boolean
  /** Focus going to this element is not the editor being left. */
  keepOpenFor?: (target: EventTarget | null) => boolean
}

/**
 * The editor of a cell that takes typed text: Enter saves and moves down, Tab moves right (with
 * Shift the other way), Escape gives up, F2 switches between typing and editing, and leaving the
 * input hands over what was typed.
 */
export function TextEditor({
  initial,
  label,
  align,
  entered = false,
  onCommit,
  onCancel,
  onLeave,
  onKey,
  keepOpenFor,
}: TextEditorProps) {
  // Saving or giving up closes the editor, and closing it blurs the input: once is enough.
  const settled = useRef(false)
  const [invalid, setInvalid] = useState(false)
  const [entering, setEntering] = useState(entered)

  const open = useCallback(
    (input: HTMLInputElement | null) => {
      input?.focus()
      input?.setSelectionRange(initial.length, initial.length)
    },
    [initial],
  )

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (onKey?.(event)) {
      return
    }
    const command = resolveKey(keyInput(event.nativeEvent), entering ? "enter" : "edit")
    if (command.type === "switchMode") {
      event.preventDefault()
      setEntering((now) => !now)
    } else if (command.type === "cancel") {
      event.preventDefault()
      settled.current = true
      onCancel()
    } else if (command.type === "commit") {
      event.preventDefault()
      // Closing the editor moves the focus, which would hand the text over a second time.
      settled.current = true
      if (!onCommit(event.currentTarget.value, command.move)) {
        settled.current = false
        setInvalid(true)
      }
    }
  }

  return (
    <Input
      ref={open}
      aria-label={label}
      aria-invalid={invalid || undefined}
      autoComplete="off"
      defaultValue={initial}
      className={cn(
        "h-full rounded-none border-primary bg-background px-2 text-sm shadow-none md:text-sm dark:bg-background",
        "focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary",
        align === "right" && "text-right tabular-nums",
      )}
      onChange={() => setInvalid(false)}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        if (settled.current || keepOpenFor?.(event.relatedTarget)) {
          return
        }
        settled.current = true
        onLeave(event.currentTarget.value)
      }}
    />
  )
}
