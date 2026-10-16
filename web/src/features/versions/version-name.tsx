import { zodResolver } from "@hookform/resolvers/zod"
import { Pencil } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { reportFormError } from "@/lib/form-errors"
import { structureNameSchema } from "@/lib/validation"

const schema = z.object({ name: structureNameSchema })

type NameValues = z.infer<typeof schema>

/** Where a refusal that carries only a code belongs: a name that is taken is about the name. */
const FIELD_ERRORS = { "structure.name_taken": "name" } as const

interface VersionNameProps {
  name: string
  /** Saves the new name; a refusal it throws is shown under the input. */
  onRename: (name: string) => Promise<void>
}

/** The name of a version, which turns into an input when it is clicked. */
export function VersionName({ name, onRename }: VersionNameProps) {
  const [editing, setEditing] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  // Whether focus goes back to the name once the input is gone: after Enter or Escape, not after
  // the user has moved on to something else.
  const refocus = useRef(false)

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false
      button.current?.focus()
    }
  }, [editing])

  if (editing) {
    return (
      <NameInput
        name={name}
        onRename={onRename}
        onDone={(focusName) => {
          refocus.current = focusName
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
      aria-label={`Rename ${name}`}
      className="-ml-2.5 max-w-full justify-start px-2.5 font-medium"
      onClick={() => setEditing(true)}
    >
      <span className="truncate" title={name}>
        {name}
      </span>
      <Pencil className="text-muted-foreground" />
    </Button>
  )
}

interface NameInputProps extends VersionNameProps {
  /** Called when editing is over, with whether focus should go back to the name. */
  onDone: (focusName: boolean) => void
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

  function finish(focusName: boolean) {
    over.current = true
    onDone(focusName)
  }

  const save = (focusName: boolean) =>
    form.handleSubmit(async ({ name: renamed }) => {
      if (renamed === name) {
        finish(focusName)
        return
      }
      setSaving(true)
      try {
        await onRename(renamed)
        finish(focusName)
      } catch (error) {
        reportFormError(form, error, FIELD_ERRORS)
      } finally {
        setSaving(false)
      }
    })

  return (
    <Form {...form}>
      <form onSubmit={(event) => void save(true)(event)} noValidate>
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
                  aria-label={`Name of ${name}`}
                  autoComplete="off"
                  readOnly={saving}
                  className="h-8"
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
