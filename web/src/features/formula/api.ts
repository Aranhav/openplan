import type { QueryClient } from "@tanstack/react-query"
import { type FormulaProblem, api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import type { components } from "@/lib/api/schema"

type Schemas = components["schemas"]

export type Completion = Schemas["CompletionDto"]
export type FormulaFunction = Schemas["FunctionDto"]

/** How long what the server offered after a prefix is taken to be right, unless the structure changes. */
const COMPLETIONS_STALE_MS = 5 * 60_000

/** What can be typed after `prefix` in the formula of a line item; kept per prefix. */
export function fetchCompletions(
  queryClient: QueryClient,
  modelId: string,
  lineItemId: string,
  prefix: string,
) {
  return queryClient.fetchQuery({
    queryKey: queryKeys.formulaCompletions(modelId, lineItemId, prefix),
    queryFn: () =>
      unwrap(
        api.GET("/models/{id}/formula/completions", {
          params: { path: { id: modelId }, query: { line_item_id: lineItemId, prefix } },
        }),
      ),
    staleTime: COMPLETIONS_STALE_MS,
  })
}

/** The built-in functions, which the server says once. */
export function fetchFunctions(queryClient: QueryClient) {
  return queryClient.fetchQuery({
    queryKey: queryKeys.formulaFunctions,
    queryFn: () => unwrap(api.GET("/formula/functions")),
    staleTime: Infinity,
  })
}

/** What is wrong with `formula` as the formula of a line item, without saving it: none when it is fine. */
export async function checkFormula(
  modelId: string,
  lineItemId: string,
  formula: string,
  signal?: AbortSignal,
): Promise<FormulaProblem[]> {
  const result = await unwrap(
    api.POST("/models/{id}/formula/check", {
      params: { path: { id: modelId } },
      body: { line_item_id: lineItemId, formula },
      signal,
    }),
  )
  return result.ok ? [] : result.errors
}
