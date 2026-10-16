import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { reportFormError } from "@/lib/form-errors"
import { INLINE_TEXT_ATTRIBUTE } from "@/lib/inline-text"
import { cn } from "@/lib/utils"

type TextValues = { text: string }

/** A name or a code that is taken is shown under the input. */
const NAME_TAKEN = { "structure.name_taken": "text" } as const

interface InlineTextProps {
  value: string
  /** What assistive technology calls the button that starts the edit: "Rename Paris". */
  label: string
  /** What it calls the input while editing: "Name of Paris". */
  inputLabel: string
  /** What the text must be like; a blank text is only fine if the schema says so. */
  schema: z.ZodString
  /** Saves the new text; a refusal it throws is shown under the input. */
  onSave: (text: string) => Promise<void>
  /** Stands in for an empty value. */
  placeholder?: string
  /** Shown after the text, such as a pencil that says it can be edited. */
  icon?: ReactNode
  className?: string
}

/**
 * Text that turns into an input when it is clicked or Enter is pressed on it. Enter saves, Escape
 * puts the old text back, and leaving the input saves too. Focus goes back to the text after
 * Enter and Escape, but not after leaving the input for something else.
 */
export function InlineText({
  value,
  label,
  inputLabel,
  schema,
  onSave,
  placeholder,
  icon,
  className,
}: InlineTextProps) {
  const [editing, setEditing] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false
      button.current?.focus()
    }
  }, [editing])

  if (editing) {
    return (
      <TextInput
        value={value}
        inputLabel={inputLabel}
        schema={schema}
        onSave={onSave}
        onDone={(focusText) => {
          refocus.current = focusText
          setEditing(false)
        }}
      />
    )
  }
  return (
    <Button
      ref={button}
      variant="ghost"
      size="sm"
      aria-label={label}
      className={cn("-ml-2.5 max-w-full justify-start px-2.5 font-normal", className)}
      onClick={() => setEditing(true)}
    >
      <span
        className={cn("truncate", !value && "text-muted-foreground")}
        title={value || undefined}
      >
        {value || placeholder}
      </span>
      {icon}
    </Button>
  )
}

interface TextInputProps extends Pick<
  InlineTextProps,
  "value" | "inputLabel" | "schema" | "onSave"
> {
  /** Called when editing is over, with whether focus should go back to the text. */
  onDone: (focusText: boolean) => void
}

function TextInput({ value, inputLabel, schema, onSave, onDone }: TextInputProps) {
  const form = useForm<TextValues>({
    resolver: zodResolver(z.object({ text: schema })),
    defaultValues: { text: value },
  })
  const input = useRef<HTMLInputElement | null>(null)
  const [saving, setSaving] = useState(false)
  // Set once the edit is over, so that the input leaving the page does not save it again.
  const over = useRef(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  function finish(focusText: boolean) {
    over.current = true
    onDone(focusText)
  }

  const save = (focusText: boolean) =>
    form.handleSubmit(async ({ text }) => {
      if (text === value) {
        finish(focusText)
        return
      }
      setSaving(true)
      try {
        await onSave(text)
        finish(focusText)
      } catch (error) {
        reportFormError(form, error, NAME_TAKEN)
      } finally {
        setSaving(false)
      }
    })

  return (
    <Form {...form}>
      <form onSubmit={(event) => void save(true)(event)} noValidate>
        <FormField
          control={form.control}
          name="text"
          render={({ field }) => (
            <FormItem className="gap-1">
              <div className="relative">
                <FormControl>
                  <Input
                    {...field}
                    ref={(element) => {
                      field.ref(element)
                      input.current = element
                    }}
                    {...{ [INLINE_TEXT_ATTRIBUTE]: "" }}
                    aria-label={inputLabel}
                    autoComplete="off"
                    readOnly={saving}
                    className="h-8 pr-8"
                    onBlur={() => {
                      field.onBlur()
                      if (!over.current && !saving) {
                        void save(false)()
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation()
                        finish(true)
                      }
                    }}
                  />
                </FormControl>
                {saving && (
                  <Loader2
                    aria-hidden
                    className="absolute top-2 right-2 size-4 animate-spin text-muted-foreground"
                  />
                )}
              </div>
              <FormMessage className="whitespace-normal" />
            </FormItem>
          )}
        />
      </form>
    </Form>
  )
}
