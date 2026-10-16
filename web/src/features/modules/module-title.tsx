import { zodResolver } from "@hookform/resolvers/zod"
import { Pencil } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { ProductionLock } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { NAME_TAKEN_FIELD_ERRORS, reportFormError } from "@/lib/form-errors"
import { structureNameSchema } from "@/lib/validation"

const schema = z.object({ name: structureNameSchema })

type NameValues = z.infer<typeof schema>

const TITLE = "text-2xl font-semibold tracking-tight break-words outline-none"

interface ModuleTitleProps {
  name: string
  /** Saves the new name; a refusal it throws is shown under the input. */
  onRename?: (name: string) => Promise<void>
  /** Whether production mode switches renaming off. */
  locked: boolean
}

/**
 * The name of a module, as the title of its page. Where the user may rename it, a button next to
 * it turns the title into an input: Enter saves, Escape gives up, and leaving the input saves.
 */
export function ModuleTitle({ name, onRename, locked }: ModuleTitleProps) {
  const [editing, setEditing] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  // Whether focus goes back to the button once the input is gone: after Enter or Escape, not
  // after the user has moved on to something else.
  const refocus = useRef(false)

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false
      button.current?.focus()
    }
  }, [editing])

  if (editing && onRename) {
    return (
      <>
        <h1 className="sr-only">{name}</h1>
        <NameInput
          name={name}
          onRename={onRename}
          onDone={(focusButton) => {
            refocus.current = focusButton
            setEditing(false)
          }}
        />
      </>
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-1">
      <h1 tabIndex={-1} className={TITLE}>
        {name}
      </h1>
      {onRename && (
        <ProductionLock locked={locked}>
          <Button
            ref={button}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Rename module"
            disabled={locked}
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </Button>
        </ProductionLock>
      )}
    </div>
  )
}

interface NameInputProps {
  name: string
  onRename: (name: string) => Promise<void>
  /** Called when editing is over, with whether focus should go back to the rename button. */
  onDone: (focusButton: boolean) => void
}

function NameInput({ name, onRename, onDone }: NameInputProps) {
  const form = useForm<NameValues>({ resolver: zodResolver(schema), defaultValues: { name } })
  const input = useRef<HTMLInputElement | null>(null)
  const [saving, setSaving] = useState(false)
  // Set once the edit is over, so that the input leaving the page does not save it again.
  const over = useRef(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  function finish(focusButton: boolean) {
    over.current = true
    onDone(focusButton)
  }

  const save = (focusButton: boolean) =>
    form.handleSubmit(async ({ name: renamed }) => {
      if (renamed === name) {
        finish(focusButton)
        return
      }
      setSaving(true)
      try {
        await onRename(renamed)
        finish(focusButton)
      } catch (error) {
        reportFormError(form, error, NAME_TAKEN_FIELD_ERRORS)
      } finally {
        setSaving(false)
      }
    })

  return (
    <Form {...form}>
      <form onSubmit={(event) => void save(true)(event)} noValidate className="max-w-xl">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem className="gap-1">
              <FormControl>
                <Input
                  {...field}
                  ref={(element) => {
                    field.ref(element)
                    input.current = element
                  }}
                  aria-label="Module name"
                  autoComplete="off"
                  readOnly={saving}
                  className="h-10 text-2xl font-semibold tracking-tight md:text-2xl"
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
              <FormMessage />
            </FormItem>
          )}
        />
      </form>
    </Form>
  )
}
