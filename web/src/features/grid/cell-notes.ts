import type { Cell, LineItemInfo } from "./view-types"

export const SWITCHOVER_NOTE = "Before the switchover: showing Actual."
const ERROR_NOTE = "This line item has an error."

/** The id of the hidden text that describes every cell showing the Actual before a switchover. */
export function switchoverNoteId(gridId: string): string {
  return `${gridId}-switchover`
}

/** The id of the hidden text that gives the first error of a line item. */
export function errorNoteId(gridId: string, lineItemId: string): string {
  return `${gridId}-error-${lineItemId}`
}

export function cellId(gridId: string, row: number, col: number): string {
  return `${gridId}-r${row}c${col}`
}

/** What a cell cannot say with its value: why it shows the Actual, or why it is blank. */
export function noteOf(
  cell: Cell | undefined,
  lineItem: LineItemInfo | undefined,
): string | undefined {
  if (!cell) {
    return undefined
  }
  if (cell.flags.includes("error")) {
    return lineItem?.errors[0]?.message ?? ERROR_NOTE
  }
  return cell.flags.includes("switchover") ? SWITCHOVER_NOTE : undefined
}
