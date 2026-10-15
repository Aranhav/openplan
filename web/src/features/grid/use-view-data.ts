import {
  type UseQueryResult,
  hashKey,
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useEffectEvent, useMemo, useState } from "react"
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
  return useQuery(blockOptions(modelId, query, ORIGIN))
}

/** What the first block says about a view as a whole. */
type ViewShape = {
  /** The size and dimensions are known. */
  hasShape: boolean
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
    totalRows: data?.total_rows ?? 0,
    totalColumns: data?.total_columns ?? 0,
    rowDims: data?.row_dims ?? NO_DIMS,
    columnDims: data?.column_dims ?? NO_DIMS,
    pages: data?.pages ?? NO_PAGES,
  }
}

export type ViewData = ViewShape & {
  /**
   * The view shown is the previous query's, kept until the changed query has loaded the first
   * block and the blocks that hold what is visible; the grid dims it meanwhile.
   */
  isPlaceholder: boolean
  error: Error | null
  lineItems: LineItemInfo[]
  /** The header of a row, once the block that holds it has loaded. */
  rowHeaders(row: number): Header | undefined
  colHeaders(col: number): Header | undefined
  cell(row: number, col: number): Cell | undefined
  isFetching: boolean
  /** Loads every block on show again, which is what a retry after an error needs. */
  refetch(): Promise<void>
  /**
   * Loads the blocks that hold `range` (both ends included), and the first block, unless they
   * are loaded, and answers with what they hold. For acting on cells that are not on screen.
   */
  load(range: CellRange): Promise<Lookup>
  /**
   * What `load` would answer, if every block it needs is loaded already and current, and nothing
   * if not (a block that was invalidated counts as not loaded).
   */
  peek(range: CellRange): Lookup | undefined
}

type Loaded = {
  block: Block
  result: QueryResult
  fetching: boolean
  /** The last load of the block failed; its older data is still all there is. */
  errored: boolean
  updatedAt: number
}

export type Lookup = Pick<ViewData, "lineItems" | "rowHeaders" | "colHeaders" | "cell">

// Large enough that no two blocks of a view share a key.
const KEY_STRIDE = 1_000_000

function blockKey(rowBlock: number, colBlock: number): number {
  return rowBlock * KEY_STRIDE + colBlock
}

function sameDims(a: readonly ViewDim[], b: readonly ViewDim[]): boolean {
  return a.length === b.length && a.every((dim, i) => JSON.stringify(dim) === JSON.stringify(b[i]))
}

/** Blocks of one view that have the same size and dimensions line up, whenever they were read. */
function sameShape(a: QueryResult, b: QueryResult): boolean {
  return (
    a.total_rows === b.total_rows &&
    a.total_columns === b.total_columns &&
    sameDims(a.row_dims, b.row_dims) &&
    sameDims(a.column_dims, b.column_dims)
  )
}

/**
 * Merges loaded blocks into lookups by the position of a row, column or cell in the whole view.
 * The newest response says what shape the view has. A block of another shape would not line up
 * with it (rows were added, a dimension moved), so it is left out and handed back as stale, to
 * be loaded again. Blocks of the same shape merge whatever revision they were read at: a change
 * to some cells leaves the others as they were.
 */
function assemble(loaded: readonly Loaded[]): { lookup: Lookup; stale: Loaded[] } {
  const newest = loaded.reduce<Loaded | undefined>(
    (best, candidate) => (!best || candidate.updatedAt > best.updatedAt ? candidate : best),
    undefined,
  )
  const cellBlocks = new Map<number, QueryResult>()
  const rowBlocks = new Map<number, QueryResult>()
  const colBlocks = new Map<number, QueryResult>()
  const lineItems = new Map<string, LineItemInfo>()
  const stale: Loaded[] = []
  for (const entry of loaded) {
    const { block, result } = entry
    if (newest && !sameShape(result, newest.result)) {
      stale.push(entry)
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
    stale,
    lookup: {
      lineItems: [...lineItems.values()],
      rowHeaders: (row) => rowBlocks.get(Math.floor(row / ROW_BLOCK))?.rows[row % ROW_BLOCK],
      colHeaders: (col) => colBlocks.get(Math.floor(col / COL_BLOCK))?.columns[col % COL_BLOCK],
      cell: (row, col) =>
        cellBlocks.get(blockKey(Math.floor(row / ROW_BLOCK), Math.floor(col / COL_BLOCK)))?.cells[
          row % ROW_BLOCK
        ]?.[col % COL_BLOCK],
    },
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
  /** Whether the last load of each block failed. */
  readonly errored: readonly boolean[]
  /** When each block's answer arrived. */
  readonly updatedAt: readonly number[]
  readonly isFetching: boolean
  readonly error: Error | null

  constructor(
    data: readonly (QueryResult | undefined)[],
    fetching: readonly boolean[],
    errored: readonly boolean[],
    updatedAt: readonly number[],
    error: Error | null,
  ) {
    this.data = data
    this.fetching = fetching
    this.errored = errored
    this.updatedAt = updatedAt
    this.isFetching = fetching.some(Boolean)
    this.error = error
  }
}

function combineBlocks(results: UseQueryResult<QueryResult, Error>[]): BlockResults {
  return new BlockResults(
    results.map((result) => result.data),
    results.map((result) => result.isFetching),
    results.map((result) => result.isError),
    results.map((result) => result.dataUpdatedAt),
    results.find((result) => result.error)?.error ?? null,
  )
}

const EMPTY_LOOKUP: Lookup = {
  lineItems: [],
  rowHeaders: () => undefined,
  colHeaders: () => undefined,
  cell: () => undefined,
}

/** A view that finished loading, kept to show while the next one loads. */
type Settled = { key: string; shape: ViewShape; lookup: Lookup }

/**
 * The cells of a pivot, loaded in blocks as `visible` (both ends included) moves over it, and
 * looked up by their position in the whole view. Blocks stay cached, so scrolling back is instant.
 *
 * When `query` changes (a member is collapsed, a filter set), the last view that had loaded stays
 * on show, as a placeholder, until the first block and the blocks that hold the visible cells of
 * the new query have arrived, so the grid does not go blank in between.
 */
export function useViewData(modelId: string, query: GridQuery, visible: CellRange): ViewData {
  const queryClient = useQueryClient()
  const origin = useOriginBlock(modelId, query)
  const shape = shapeOf(origin)
  const sized = shape.hasShape
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

  const originResult = origin.data
  const originUpdatedAt = origin.dataUpdatedAt
  const originFetching = origin.isFetching
  const originErrored = origin.isError
  const merged = useMemo(() => {
    const loaded: Loaded[] = originResult
      ? [
          {
            block: ORIGIN,
            result: originResult,
            fetching: originFetching,
            errored: originErrored,
            updatedAt: originUpdatedAt,
          },
        ]
      : []
    wanted.forEach(({ block }, index) => {
      const result = others.data[index]
      if (result) {
        loaded.push({
          block,
          result,
          fetching: others.fetching[index],
          errored: others.errored[index],
          updatedAt: others.updatedAt[index],
        })
      }
    })
    return assemble(loaded)
  }, [originResult, originUpdatedAt, originFetching, originErrored, wanted, others])
  const { lookup } = merged

  // Blocks that no longer describe the view are loaded again, unless they already are, or the
  // last attempt failed: asking again would only fail again, and again. A retry does it.
  const reloadKeys = merged.stale
    .filter((entry) => !entry.fetching && !entry.errored)
    .map(({ block }) => `${block.rowBlock}:${block.colBlock}`)
    .join(",")
  const reload = useEffectEvent((keys: string) => {
    for (const key of keys.split(",")) {
      const [rowBlock, colBlock] = key.split(":").map(Number)
      void queryClient.refetchQueries(
        { queryKey: queryKeys.query(modelId, query, { rowBlock, colBlock }), exact: true },
        { cancelRefetch: false },
      )
    }
  })
  useEffect(() => {
    if (reloadKeys !== "") {
      reload(reloadKeys)
    }
  }, [reloadKeys])

  // The view is settled once the first block and the blocks with the visible cells are in.
  const key = hashKey([modelId, query])
  const loadedNow =
    originResult !== undefined &&
    wanted.every(({ neighbour }, index) => neighbour || others.data[index] || others.errored[index])
  const [settled, setSettled] = useState<Settled | null>(null)
  if (loadedNow && (settled === null || settled.key !== key || settled.lookup !== lookup)) {
    setSettled({ key, shape, lookup })
  }
  const error = origin.error ?? others.error

  // The blocks of a range and the first, from the cache, which holds every block that has been
  // loaded whether or not the grid shows it now.
  const blocksOf = (range: CellRange): Block[] =>
    [ORIGIN, ...blocksFor(range)].filter(
      (block, index, all) =>
        all.findIndex((b) => b.rowBlock === block.rowBlock && b.colBlock === block.colBlock) ===
        index,
    )
  const read = (range: CellRange): Lookup | undefined => {
    const loaded: Loaded[] = []
    for (const block of blocksOf(range)) {
      const state = queryClient.getQueryState<QueryResult>(queryKeys.query(modelId, query, block))
      // Blocks that were invalidated hold what was true before the change.
      if (!state?.data || state.isInvalidated) {
        return undefined
      }
      loaded.push({
        block,
        result: state.data,
        fetching: false,
        errored: false,
        updatedAt: state.dataUpdatedAt,
      })
    }
    return assemble(loaded).lookup
  }
  const showPrevious = !loadedNow && settled !== null && settled.key !== key
  const shown = showPrevious ? settled : { shape, lookup }

  return {
    ...shown.shape,
    ...shown.lookup,
    error,
    isPlaceholder: showPrevious && error === null,
    isFetching: origin.isFetching || others.isFetching,
    refetch: () =>
      queryClient
        .refetchQueries({ queryKey: queryKeys.query(modelId, query), type: "active" })
        .then(() => undefined),
    load: async (range) => {
      // A block that was invalidated is loaded again, one that is current is taken as it is.
      await Promise.all(
        blocksOf(range).map((block) => queryClient.fetchQuery(blockOptions(modelId, query, block))),
      )
      return read(range) ?? EMPTY_LOOKUP
    },
    peek: read,
  }
}
