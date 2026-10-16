import type { FieldPath, FieldValues, UseFormReturn } from "react-hook-form"
import { toast } from "sonner"
import { ApiError, errorDetail } from "@/lib/api/client"

/**
 * Reports a failed save: under the input the server complained about, else in a toast. The server
 * names inputs in `errors`; a refusal that carries only a code (`codeFields`, e.g. an email that
 * is already taken) is shown under the input it is about, with the server's own wording.
 */
export function reportFormError<T extends FieldValues>(
  form: UseFormReturn<T>,
  error: unknown,
  codeFields: Record<string, FieldPath<T>> = {},
) {
  if (error instanceof ApiError) {
    const field = codeFields[error.code]
    if (field) {
      form.setError(field, { message: error.detail }, { shouldFocus: true })
      return
    }
    const known = error.errors.filter(({ field }) => Object.hasOwn(form.getValues(), field))
    known.forEach(({ field, message }, index) => {
      form.setError(field as FieldPath<T>, { message }, { shouldFocus: index === 0 })
    })
    if (known.length > 0) {
      return
    }
  }
  toast.error(errorDetail(error))
}

/** For a form with a name: a name that is taken (`structure.name_taken`) is shown under the name. */
export const NAME_TAKEN_FIELD_ERRORS = { "structure.name_taken": "name" } as const
