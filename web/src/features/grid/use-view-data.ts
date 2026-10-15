import {
  type UseQueryResult,
  keepPreviousData,
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useMemo } from "react"
import { queryKeys } from "@/lib/api/keys"
import { type Block, COL_BLOCK, ROW_BLOCK, blocksFor, windowOf } from "./core/blocks"
import type { CellRange } from "./core/selection"
import { queryView } from "./query-api"
import type {
  Cell,
  GridQuery,
  Header,
  LineItemInfo,
  PageMember,
  QueryResult,
  ViewDim,
} from "./view-types"

/** The first block always loads: it carries the size of the view and its dimensions. */
const ORIGIN: Block = { rowBlock: 0, colBlock: 0 }

const NO_DIMS: ViewDim[] = []
const NO_PAGES: PageMember[] = []

// How long a block that is not on screen waits before it is asked for. A fast scroll passes over
// many blocks; one that is gone again within this time is cancelled before any request is sent.
const SETTLE_MS = 80

function settle(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, SETTLE_MS)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

function blockOptions(modelId: string, query: GridQuery, block: Block, waitToSettle = false) {
  return queryOptions({
    queryKey: queryKeys.query(modelId, query, block),
    queryFn: async ({ signal }) => {
      if (waitToSettle) {
        await settle(signal)
      }
      return queryView(modelId, { ...query, window: windowOf(block) }, signal)
    },
  })
}

function useOriginBlock(modelId: string, query: GridQuery) {
  // Keeping the last view while the next one loads lets the grid stay where it is when a
  // collapse, filter or page change asks for a new query.
  return useQuery({ ...blockOptions(modelId, query, ORIGIN), placeholderData: keepPreviousData })
}

/** What the first block says about a view as a whole. */
type ViewShape = {
  /** The size and dimensions are known, if only from the previous query (see `isPlaceholder`). */
  hasShape: boolean
  /** The shape is the previous query's, kept until the current one arrives. */
  isPlaceholder: boolean
  error: Error | null
  totalRows: number
  totalColumns: number
  rowDims: ViewDim[]
  columnDims: ViewDim[]
  pages: PageMember[]
}

function shapeOf(origin: UseQueryResult<QueryResult, Error>): ViewShape {
  const data = origin.data
  return {
    hasShape: data !== undefined,
    isPlaceholder: origin.isPlaceholderData,
    error: origin.error,
    totalRows: data?.total_rows ?? 0,
    totalColumns: data?.total_columns ?? 0,
    rowDims: data?.row_dims ?? NO_DIMS,
    columnDims: data?.column_dims ?? NO_DIMS,
    pages: data?.pages ?? NO_PAGES,
  }
}

export type ViewData = ViewShape & {
  lineItems: LineItemInfo[]
  /** The header of a row, once the block that holds it has loaded. */
  rowHeaders(row: number): Header | undefined
  colHeaders(col: number): Header | undefined
  cell(row: number, col: number): Cell | undefined
  isFetching: boolean
  /** Loads every block on show again, which is what a retry after an error needs. */
  refetch(): Promise<void>
}

type Loaded = { block: Block; result: QueryResult; fetching: boolean }

type Lookup = Pick<ViewData, "lineItems" | "rowHeaders" | "colHeaders" | "cell">

// Large enough that no two blocks of a view share a key.
const KEY_STRIDE = 1_000_000

function blockKey(rowBlock: number, colBlock: number): number {
  return rowBlock * KEY_STRIDE + colBlock
}

/**
 * Merges loaded blocks into lookups by the position of a row, column or cell in the whole view.
 * A block read at another revision of the model than the first block would not line up with it,
 * so it is left out, unless it is being loaded again, when what it holds is the best there is.
 */
function assemble(loaded: readonly Loaded[], seq: number | undefined): Lookup {
  const cellBlocks = new Map<number, QueryResult>()
  const rowBlocks = new Map<number, QueryResult>()
  const colBlocks = new Map<number, QueryResult>()
  const lineItems = new Map<string, LineItemInfo>()
  for (const { block, result, fetching } of loaded) {
    if (seq !== undefined && result.seq !== seq && !fetching) {
      continue
    }
    cellBlocks.set(blockKey(block.rowBlock, block.colBlock), result)
    rowBlocks.set(block.rowBlock, result)
    colBlocks.set(block.colBlock, result)
    for (const lineItem of result.line_items) {
      // The first block to list a line item gives its object, so it does not change as others load.
      if (!lineItems.has(lineItem.id)) {
        lineItems.set(lineItem.id, lineItem)
      }
    }
  }
  return {
    lineItems: [...lineItems.values()],
    rowHeaders: (row) => rowBlocks.get(Math.floor(row / ROW_BLOCK))?.rows[row % ROW_BLOCK],
    colHeaders: (col) => colBlocks.get(Math.floor(col / COL_BLOCK))?.columns[col % COL_BLOCK],
    cell: (row, col) =>
      cellBlocks.get(blockKey(Math.floor(row / ROW_BLOCK), Math.floor(col / COL_BLOCK)))?.cells[
        row % ROW_BLOCK
      ]?.[col % COL_BLOCK],
  }
}

type Wanted = { block: Block; /** Next to what is visible, not part of it. */ neighbour: boolean }

/**
 * The blocks to load besides the first: those that hold the visible cells and, once the size of
 * the view is known, the blocks next to them, so scrolling by a screen finds its cells loaded.
 */
function wantedBlocks(visible: CellRange, size?: { rows: number; cols: number }): Wanted[] {
  const holding = blocksFor(visible)
  const blocks = size
    ? blocksFor({
        rowStart: visible.rowStart - ROW_BLOCK,
        rowEnd: visible.rowEnd + ROW_BLOCK,
        colStart: visible.colStart - COL_BLOCK,
        colEnd: visible.colEnd + COL_BLOCK,
      }).filter(
        ({ rowBlock, colBlock }) =>
          rowBlock * ROW_BLOCK < size.rows && colBlock * COL_BLOCK < size.cols,
      )
    : holding
  return blocks
    .filter(({ rowBlock, colBlock }) => rowBlock !== 0 || colBlock !== 0)
    .map((block) => ({
      block,
      neighbour: !holding.some(
        (held) => held.rowBlock === block.rowBlock && held.colBlock === block.colBlock,
      ),
    }))
}

/**
 * What the blocks besides the first have loaded. It is a class so that Query, which compares what
 * `combine` returns with the last answer to keep what has not changed, does not walk the cells.
 */
class BlockResults {
  readonly data: readonly (QueryResult | undefined)[]
  /** Whether each block is being loaded (again) right now. */
  readonly fetching: readonly boolean[]
  readonly isFetching: boolean
  readonly error: Error | null

  constructor(
    data: readonly (QueryResult | undefined)[],
    fetching: readonly boolean[],
    error: Error | null,
  ) {
    this.data = data
    this.fetching = fetching
    this.isFetching = fetching.some(Boolean)
    this.error = error
  }
}

function combineBlocks(results: UseQueryResult<QueryResult, Error>[]): BlockResults {
  return new BlockResults(
    results.map((result) => result.data),
    results.map((result) => result.isFetching),
    results.find((result) => result.error)?.error ?? null,
  )
}

/**
 * The cells of a pivot, loaded in blocks as `visible` (both ends included) moves over it, and
 * looked up by their position in the whole view. Blocks stay cached, so scrolling back is instant.
 */
export function useViewData(modelId: string, query: GridQuery, visible: CellRange): ViewData {
  const queryClient = useQueryClient()
  const origin = useOriginBlock(modelId, query)
  const shape = shapeOf(origin)
  const sized = shape.hasShape && !shape.isPlaceholder
  const { totalRows, totalColumns } = shape
  // Only the blocks matter, so the list of blocks to load is the same until the view crosses one.
  const firstRowBlock = Math.floor(Math.max(visible.rowStart, 0) / ROW_BLOCK)
  const lastRowBlock = Math.floor(Math.max(visible.rowEnd, 0) / ROW_BLOCK)
  const firstColBlock = Math.floor(Math.max(visible.colStart, 0) / COL_BLOCK)
  const lastColBlock = Math.floor(Math.max(visible.colEnd, 0) / COL_BLOCK)

  const wanted = useMemo(
    () =>
      wantedBlocks(
        {
          rowStart: firstRowBlock * ROW_BLOCK,
          rowEnd: lastRowBlock * ROW_BLOCK,
          colStart: firstColBlock * COL_BLOCK,
          colEnd: lastColBlock * COL_BLOCK,
        },
        sized ? { rows: totalRows, cols: totalColumns } : undefined,
      ),
    [firstRowBlock, lastRowBlock, firstColBlock, lastColBlock, sized, totalRows, totalColumns],
  )
  const others = useQueries({
    queries: wanted.map(({ block, neighbour }) => blockOptions(modelId, query, block, neighbour)),
    combine: combineBlocks,
  })

  const originResult = origin.isPlaceholderData ? undefined : origin.data
  const lookup = useMemo(() => {
    const loaded: Loaded[] = originResult
      ? [{ block: ORIGIN, result: originResult, fetching: false }]
      : []
    wanted.forEach(({ block }, index) => {
      const result = others.data[index]
      if (result) {
        loaded.push({ block, result, fetching: others.fetching[index] })
      }
    })
    return assemble(loaded, originResult?.seq)
  }, [originResult, wanted, others.data, others.fetching])

  return {
    ...shape,
    ...lookup,
    error: shape.error ?? others.error,
    isFetching: origin.isFetching || others.isFetching,
    refetch: () =>
      queryClient
        .refetchQueries({ queryKey: queryKeys.query(modelId, query), type: "active" })
        .then(() => undefined),
  }
}
