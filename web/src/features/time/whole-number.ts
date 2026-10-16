import { z } from "zod"

/** The whole number that `text` spells, if it is one from `min` to `max`. */
export function wholeNumberIn(text: string, min: number, max: number) {
  const trimmed = text.trim()
  const value = Number(trimmed)
  return /^\d+$/.test(trimmed) && value >= min && value <= max ? value : undefined
}

/** A whole number from `min` to `max`, typed into a field, which holds it as text. */
export function wholeNumberSchema(label: string, min: number, max: number) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .regex(/^\d+$/, `${label} must be a whole number.`)
    .refine(
      (value) => wholeNumberIn(value, min, max) !== undefined,
      `${label} must be between ${min} and ${max}.`,
    )
}
