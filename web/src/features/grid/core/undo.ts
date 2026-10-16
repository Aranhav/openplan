import type { CellRange } from "./selection"
import type { Value } from "./types"

/** One cell's change. `coords` are the member keys of the line item's own dimensions. */
export type CellEdit = {
  lineItemId: string
  coords: string[]
  before: Value
  after: Value
}

/**
 * Where in the grid a batch was made: a range of positions, in the view whose query has the key
 * `view`. In another view (a member was collapsed, a filter set) the same positions are other
 * cells.
 */
export type Placement = { range: CellRange; view: string }

/**
 * Edits made together (one typed value, one paste), undone and redone together. `where` is the
 * place of the grid they were made in, for the grid to select again when it undoes or redoes them.
 */
export type EditBatch = { edits: CellEdit[]; where?: Placement }

const MAX_ENTRIES = 100

/**
 * The user's own edits in a module, oldest to newest. `undo` hands back the newest batch for
 * the caller to apply with each edit's `before`, `redo` the newest undone one to apply with
 * `after`. A new push drops whatever could still be redone.
 */
export class UndoStack {
  #undoable: EditBatch[] = []
  #redoable: EditBatch[] = []

  get canUndo(): boolean {
    return this.#undoable.length > 0
  }

  get canRedo(): boolean {
    return this.#redoable.length > 0
  }

  push(batch: EditBatch): void {
    if (batch.edits.length === 0) {
      return
    }
    this.#redoable = []
    this.#undoable.push(batch)
    if (this.#undoable.length > MAX_ENTRIES) {
      this.#undoable.shift()
    }
  }

  undo(): EditBatch | undefined {
    const batch = this.#undoable.pop()
    if (batch) {
      this.#redoable.push(batch)
    }
    return batch
  }

  redo(): EditBatch | undefined {
    const batch = this.#redoable.pop()
    if (batch) {
      this.#undoable.push(batch)
    }
    return batch
  }
}
