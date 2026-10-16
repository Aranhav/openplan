import { z } from "zod"
import { structureNameSchema } from "@/lib/validation"

/** What the parent list's select holds for a list without one; a list's id never looks like this. */
export const NO_PARENT = "none"

/** The longest name of a list's top level, as the server keeps it. */
const TOP_LEVEL_NAME_MAX = 80

/** The name of the single total item above all items; blank for a list without one. */
export const topLevelNameSchema = z
  .string()
  .trim()
  .max(TOP_LEVEL_NAME_MAX, `Top level name must be at most ${TOP_LEVEL_NAME_MAX} characters.`)

/** The fields of a new list, named as the server names them so that its refusals land on the right input. */
export const newListSchema = z.object({
  name: structureNameSchema,
  parent_list_id: z.string(),
  top_level_name: topLevelNameSchema,
  numbered: z.boolean(),
  production_data: z.boolean(),
})

export type NewListValues = z.infer<typeof newListSchema>
