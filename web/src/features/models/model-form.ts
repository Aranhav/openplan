import { z } from "zod"

export const modelNameSchema = z
  .string()
  .trim()
  .min(1, "Model name is required.")
  .max(80, "Model name must be at most 80 characters.")

export const modelDescriptionSchema = z
  .string()
  .trim()
  .max(500, "Description must be at most 500 characters.")

/** Where a refusal that carries only a code belongs: a name that is taken is about the name. */
export const MODEL_FIELD_ERRORS = { "model.name_taken": "name" } as const
