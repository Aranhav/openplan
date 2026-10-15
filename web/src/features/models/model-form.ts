import type { FieldPath, FieldValues, UseFormReturn } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { ApiError, errorDetail } from "@/lib/api/client"

export const modelNameSchema = z
  .string()
  .trim()
  .min(1, "Model name is required.")
  .max(80, "Model name must be at most 80 characters.")

export const modelDescriptionSchema = z
  .string()
  .trim()
  .max(500, "Description must be at most 500 characters.")

interface ModelFormValues extends FieldValues {
  name: string
  description?: string
}

const NAME_TAKEN = "model.name_taken"

/**
 * Reports a failed save: under the field the server complained about (a name that is already
 * used counts as a complaint about the name), else in a toast.
 */
export function reportModelFormError<T extends ModelFormValues>(
  form: UseFormReturn<T>,
  error: unknown,
) {
  if (error instanceof ApiError) {
    const fieldError =
      error.code === NAME_TAKEN
        ? { field: "name", message: error.detail }
        : error.errors.find((e) => e.field === "name" || e.field === "description")
    if (fieldError) {
      form.setError(
        fieldError.field as FieldPath<T>,
        { message: fieldError.message },
        { shouldFocus: true },
      )
      return
    }
  }
  toast.error(errorDetail(error))
}
