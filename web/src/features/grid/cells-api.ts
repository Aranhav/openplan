import { api, unwrap } from "@/lib/api/client"
import type { components } from "@/lib/api/schema"

/**
 * One cell to write. `coords` are the member keys of the line item's own dimensions, in the order
 * of `LineItemInfo.dims`: an item id, a period label or a version id.
 */
export type CellWrite = components["schemas"]["CellEditDto"]

/**
 * `POST /models/{id}/cells`: all the edits are stored or none. A value that does not fit its cell
 * is a 422 `cells.invalid_value` with `errors` naming the cells, a calculated line item
 * `cells.not_input`, a coordinate that fits no cell `cells.invalid_coordinate`, and a caller who
 * may not plan in the model a 403.
 */
export function writeCells(modelId: string, edits: CellWrite[]) {
  return unwrap(
    api.POST("/models/{id}/cells", { params: { path: { id: modelId } }, body: { edits } }),
  )
}
