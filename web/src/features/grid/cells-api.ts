import { postJson } from "@/lib/api/client"
import type { Value } from "./core/types"

// The cells endpoint (M2) is not in the generated schema on this branch (Ruling M3-R8), so its
// types are written out here and a later task replaces them with the generated ones.

/**
 * One cell to write. `coords` are the member keys of the line item's own dimensions, in the order
 * of `LineItemInfo.dims`: an item id, a period label or a version id.
 */
export type CellWrite = { line_item_id: string; coords: string[]; value: Value }

export type WriteCellsResponse = {
  /** The sequence number of the change in the model's change log. */
  seq: number
  /** The line items whose cells changed: those written and those calculated again. */
  changed_line_item_ids: string[]
}

/**
 * `POST /models/{id}/cells`: all the edits are stored or none. A value that does not fit its cell
 * is a 422 `cells.invalid_value` with `errors` naming the cells, a calculated line item
 * `cells.not_input`, a coordinate that fits no cell `cells.invalid_coordinate`, and a caller who
 * may not plan in the model a 403.
 */
export function writeCells(modelId: string, edits: CellWrite[], signal?: AbortSignal) {
  return postJson<WriteCellsResponse>(
    `/models/${encodeURIComponent(modelId)}/cells`,
    { edits },
    signal,
  )
}
