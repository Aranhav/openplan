import { useQueries } from "@tanstack/react-query"
import type { RowDimInfo } from "../grid-layout"
import { rowDimInfo } from "../row-dim-info"
import type { Member, ViewDim } from "../view-types"
import { membersOptions } from "./members-api"

const NO_NESTING: RowDimInfo = { maxDepth: 0, collapsible: false, labelWidth: 0 }

export type RowInfo = {
  /** Every row dimension has been asked about, whether or not the answer came. */
  settled: boolean
  /** What each row dimension's members say, once all of them have been read. */
  dims: RowDimInfo[] | undefined
}

/**
 * What the members of the row dimensions say about the row headers: how they nest and how wide
 * their labels are, read before the grid draws its first row so that nothing shifts as the blocks
 * of the view arrive. The line items are named by the structure the screen already has; the
 * other dimensions are read from the members endpoint, and a dimension whose members cannot be
 * read is left out (the grid then sizes from the blocks) rather than holding the grid back.
 */
export function useRowInfo(
  modelId: string,
  moduleId: string,
  rows: readonly ViewDim[],
  showSummaries: boolean,
  lineItemNames: readonly string[],
): RowInfo {
  return useQueries({
    queries: rows.map((dim) =>
      dim.kind === "line_items"
        ? { ...membersOptions(modelId, moduleId, dim, showSummaries), enabled: false }
        : membersOptions(modelId, moduleId, dim, showSummaries),
    ),
    combine: (results): RowInfo => {
      const settled = results.every(
        (result, index) =>
          rows[index].kind === "line_items" || result.isSuccess || result.isError,
      )
      const failed = results.some((result, index) => rows[index].kind !== "line_items" && result.isError)
      if (!settled || failed) {
        return { settled, dims: undefined }
      }
      return {
        settled,
        dims: results.map((result, index) =>
          rows[index].kind === "line_items"
            ? rowDimInfo(lineItemNames.map(named))
            : result.data ? rowDimInfo(result.data) : NO_NESTING,
        ),
      }
    },
  })
}

function named(label: string): Member {
  return { key: label, label, depth: 0, is_summary: false, has_children: false, collapsed: false }
}
