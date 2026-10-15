import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { ApiError, errorDetail } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import { cellKey } from "./cell-targets"
import { writeCells } from "./cells-api"
import type { Value } from "./core/types"
import type { CellRange } from "./core/selection"
import { type CellEdit, UndoStack } from "./core/undo"

type Side = "before" | "after"

type Handlers = {
  /** A batch was taken up by undo or redo: where it was made. */
  onReplay?: (where: CellRange) => void
}

type Shown = { value: Value; batch: number }

/** The words for a refused write: for a value that does not fit, the first cell's own message. */
function failureMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "cells.invalid_value" && error.errors[0]) {
    return error.errors[0].message
  }
  return errorDetail(error)
}

/**
 * Writing cells for the grid of one module. A batch of edits shows at once as pending values
 * (the grid draws them in the pending style), is sent to the server, and once the server has
 * accepted it the model's views are read again before the pending values go. A refused batch
 * shows a toast and takes the values back. Accepted batches go on the module's undo stack, which
 * is dropped when the grid moves to another module.
 *
 * Batches are written one at a time in the order they were made, so a quick undo finds the edit
 * before it and two edits of one cell end with the later value.
 */
export function useCellEdits(modelId: string, moduleId: string, handlers: Handlers = {}) {
  const queryClient = useQueryClient()
  const [shown, setShown] = useState<ReadonlyMap<string, Shown>>(new Map())
  const batches = useRef(0)
  const turn = useRef<Promise<unknown>>(Promise.resolve())
  const history = useRef<{ moduleId: string; stack: UndoStack } | null>(null)

  const pending = useMemo<ReadonlyMap<string, Value>>(
    () => new Map([...shown].map(([key, entry]) => [key, entry.value])),
    [shown],
  )

  // What was done in a module cannot be undone from another, nor after coming back to it.
  useEffect(() => {
    history.current = null
  }, [moduleId])

  function stack(): UndoStack {
    if (history.current?.moduleId !== moduleId) {
      history.current = { moduleId, stack: new UndoStack() }
    }
    return history.current.stack
  }

  /** Puts the edits' values on show as pending; returns the batch to take them off with. */
  function show(edits: readonly CellEdit[], side: Side): number {
    const batch = ++batches.current
    setShown((previous) => {
      const next = new Map(previous)
      for (const edit of edits) {
        next.set(cellKey(edit.lineItemId, edit.coords), { value: edit[side], batch })
      }
      return next
    })
    return batch
  }

  function hide(batch: number) {
    setShown((previous) => {
      const next = new Map(previous)
      for (const [key, entry] of previous) {
        if (entry.batch === batch) {
          next.delete(key)
        }
      }
      return next
    })
  }

  /** Runs one write job after the ones before it have been written. */
  function inOrder<T>(job: () => Promise<T>): Promise<T> {
    const run = turn.current.then(job)
    turn.current = run.catch(() => undefined)
    return run
  }

  function post(edits: readonly CellEdit[], side: Side) {
    return writeCells(
      modelId,
      edits.map((edit) => ({
        line_item_id: edit.lineItemId,
        coords: edit.coords,
        value: edit[side],
      })),
    )
  }

  function reread() {
    return queryClient.invalidateQueries({ queryKey: queryKeys.query(modelId) })
  }

  /**
   * Writes a batch of edits made in `where`, which undo and redo select again. Resolves to whether
   * the server took it.
   */
  async function commit(edits: readonly CellEdit[], where?: CellRange): Promise<boolean> {
    if (edits.length === 0) {
      return true
    }
    const history = stack()
    const batch = show(edits, "after")
    try {
      await inOrder(async () => {
        await post(edits, "after")
        history.push({ edits: [...edits], where })
      })
      await reread()
      return true
    } catch (error) {
      toast.error(failureMessage(error))
      return false
    } finally {
      hide(batch)
    }
  }

  async function replay(direction: "undo" | "redo") {
    const history = stack()
    const side: Side = direction === "undo" ? "before" : "after"
    let batch: number | undefined
    try {
      const replayed = await inOrder(async () => {
        const entry = direction === "undo" ? history.undo() : history.redo()
        if (!entry) {
          return false
        }
        if (entry.where) {
          handlers.onReplay?.(entry.where)
        }
        batch = show(entry.edits, side)
        try {
          await post(entry.edits, side)
        } catch (error) {
          // The batch is back where it came from, to try again.
          if (direction === "undo") {
            history.redo()
          } else {
            history.undo()
          }
          throw error
        }
        return true
      })
      if (replayed) {
        await reread()
      }
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      if (batch !== undefined) {
        hide(batch)
      }
    }
  }

  return {
    /** The values being written, by `cellKey`, which the grid shows in place of the cells'. */
    pending,
    commit,
    undo: () => replay("undo"),
    redo: () => replay("redo"),
  }
}
