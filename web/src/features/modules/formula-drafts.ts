import { type Dispatch, type SetStateAction, useState } from "react"

/** The formulas typed and not saved, by line item, with how to change them. */
export type FormulaDrafts = [Record<string, string>, Dispatch<SetStateAction<Record<string, string>>>]

/** What a screen holds so that the formulas typed in the bar outlive it, as a view switch remounts the bar. */
export function useFormulaDrafts(): FormulaDrafts {
  return useState<Record<string, string>>({})
}
