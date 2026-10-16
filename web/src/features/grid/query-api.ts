import { api, unwrap } from "@/lib/api/client"
import type { QueryResult, ViewQuery } from "./view-types"

/** `POST /models/{id}/query`: one window of a pivot, with the model revision it was read at. */
export async function queryView(modelId: string, query: ViewQuery, signal?: AbortSignal) {
  const result = await unwrap(
    api.POST("/models/{id}/query", { params: { path: { id: modelId } }, body: query, signal }),
  )
  // The client's response types turn the tuple of a period value into an array of its parts;
  // the answer has the schema's own shape.
  return result as QueryResult
}
