import { postJson } from "@/lib/api/client"
import type { QueryResult, ViewQuery } from "./view-types"

/**
 * `POST /models/{id}/query`. The route is not in the generated schema yet (Ruling M3-R8), so this
 * is a typed call through the client's own CSRF and error handling instead of `api`.
 */
export function queryView(modelId: string, query: ViewQuery, signal?: AbortSignal) {
  return postJson<QueryResult>(`/models/${encodeURIComponent(modelId)}/query`, query, signal)
}
