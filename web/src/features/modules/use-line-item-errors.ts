import { useQuery } from "@tanstack/react-query"
import { queryView } from "@/features/grid/query-api"
import type { FormulaError, QueryResult } from "@/features/grid/view-types"
import type { ModuleDto } from "@/features/structure/types"
import { LINE_ITEM_ERRORS, queryKeys } from "@/lib/api/keys"
import { defaultPivot } from "./default-view"

const NO_ERRORS = new Map<string, FormulaError[]>()

function errorsByLineItem(result: QueryResult) {
  return new Map(
    result.line_items
      .filter((item) => item.errors.length > 0)
      .map((item) => [item.id, item.errors]),
  )
}

/**
 * What is wrong with the formula of each line item of a module, by line item. The structure holds
 * the formulas as they were written; it takes the model to say which of them it can still read,
 * and a query lists that for every line item of the module whatever window it asks for. A module
 * with no line items has nothing to ask about (`enabled`).
 */
export function useLineItemErrors(modelId: string, module: ModuleDto, enabled: boolean) {
  const { data } = useQuery({
    enabled,
    // Under the key of every query of the model, so that a change to the structure reads it again.
    queryKey: queryKeys.query(modelId, LINE_ITEM_ERRORS, module.id),
    queryFn: ({ signal }) =>
      queryView(
        modelId,
        {
          ...defaultPivot(module),
          window: { row_offset: 0, row_limit: 1, col_offset: 0, col_limit: 1 },
        },
        signal,
      ),
    select: errorsByLineItem,
  })
  return data ?? NO_ERRORS
}
