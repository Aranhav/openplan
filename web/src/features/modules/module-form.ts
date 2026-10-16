import { z } from "zod"
import { NAME_TAKEN_FIELD_ERRORS } from "@/lib/form-errors"
import { structureNameSchema } from "@/lib/validation"
import { MODULE_TIME_LEVELS } from "./axes"

/** The longest functional area, as the server keeps it. */
const FUNCTIONAL_AREA_MAX = 80

/** What the form of a new module and the settings of a module have in common. */
export const moduleSchema = z.object({
  name: structureNameSchema,
  functional_area: z
    .string()
    .trim()
    .max(FUNCTIONAL_AREA_MAX, `Functional area must be at most ${FUNCTIONAL_AREA_MAX} characters.`),
  dimensions: z.array(z.string()),
  time: z.boolean(),
  time_level: z.enum(MODULE_TIME_LEVELS),
  time_range: z.string(),
  versions: z.boolean(),
})

export type ModuleValues = z.infer<typeof moduleSchema>

/**
 * Where a refusal that carries only a code belongs: a name that is taken is about the name, and
 * a dimension the module cannot have (or one that would leave a line item with too many or with
 * a time scale finer than the module's) is about the dimensions.
 */
export const MODULE_FIELD_ERRORS = {
  ...NAME_TAKEN_FIELD_ERRORS,
  "structure.invalid": "dimensions",
} as const
