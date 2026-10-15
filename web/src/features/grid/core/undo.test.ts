import { describe, expect, it } from "vitest"
import { UndoStack, type EditBatch } from "./undo"

function batch(label: number): EditBatch {
  return {
    edits: [
      {
        lineItemId: "0198f0aa-0000-7000-8000-000000000001",
        coords: ["Jan 26", "0198f0aa-0000-7000-8000-00000000000a"],
        before: { t: "number", v: label },
        after: { t: "number", v: label + 1 },
      },
    ],
  }
}

describe("UndoStack", () => {
  it("starts with nothing to undo or redo", () => {
    const stack = new UndoStack()
    expect(stack.canUndo).toBe(false)
    expect(stack.canRedo).toBe(false)
    expect(stack.undo()).toBeUndefined()
    expect(stack.redo()).toBeUndefined()
  })

  it("can undo after a push, and not yet redo", () => {
    const stack = new UndoStack()
    stack.push(batch(1))
    expect(stack.canUndo).toBe(true)
    expect(stack.canRedo).toBe(false)
  })

  it("undoes the most recent batch first", () => {
    const stack = new UndoStack()
    const [a, b, c] = [batch(1), batch(2), batch(3)]
    stack.push(a)
    stack.push(b)
    stack.push(c)
    expect(stack.undo()).toBe(c)
    expect(stack.undo()).toBe(b)
    expect(stack.undo()).toBe(a)
    expect(stack.undo()).toBeUndefined()
    expect(stack.canUndo).toBe(false)
  })

  it("redoes in the order the batches were originally made", () => {
    const stack = new UndoStack()
    const [a, b, c] = [batch(1), batch(2), batch(3)]
    stack.push(a)
    stack.push(b)
    stack.push(c)
    stack.undo()
    stack.undo()
    stack.undo()
    expect(stack.canRedo).toBe(true)
    expect(stack.redo()).toBe(a)
    expect(stack.redo()).toBe(b)
    expect(stack.redo()).toBe(c)
    expect(stack.redo()).toBeUndefined()
    expect(stack.canRedo).toBe(false)
  })

  it("lets a redone batch be undone again", () => {
    const stack = new UndoStack()
    const a = batch(1)
    stack.push(a)
    stack.undo()
    expect(stack.canUndo).toBe(false)
    stack.redo()
    expect(stack.canUndo).toBe(true)
    expect(stack.canRedo).toBe(false)
    expect(stack.undo()).toBe(a)
  })

  it("clears the redo history when a new batch is pushed", () => {
    const stack = new UndoStack()
    const [a, b, c] = [batch(1), batch(2), batch(3)]
    stack.push(a)
    stack.push(b)
    stack.undo()
    expect(stack.canRedo).toBe(true)
    stack.push(c)
    expect(stack.canRedo).toBe(false)
    expect(stack.redo()).toBeUndefined()
    expect(stack.undo()).toBe(c)
    expect(stack.undo()).toBe(a)
  })

  it("keeps the redo history when an empty batch is pushed", () => {
    const stack = new UndoStack()
    stack.push(batch(1))
    stack.undo()
    stack.push({ edits: [] })
    expect(stack.canRedo).toBe(true)
    expect(stack.canUndo).toBe(false)
  })

  it("holds at most 100 batches and drops the oldest", () => {
    const stack = new UndoStack()
    const batches = Array.from({ length: 105 }, (_, index) => batch(index))
    for (const next of batches) {
      stack.push(next)
    }
    const undone: EditBatch[] = []
    while (stack.canUndo) {
      undone.push(stack.undo()!)
    }
    expect(undone).toHaveLength(100)
    expect(undone[0]).toBe(batches[104])
    expect(undone[99]).toBe(batches[5])
  })

  it("still holds 100 after undoing and redoing", () => {
    const stack = new UndoStack()
    for (let index = 0; index < 100; index++) {
      stack.push(batch(index))
    }
    stack.undo()
    stack.redo()
    stack.push(batch(100))
    let count = 0
    while (stack.undo()) {
      count++
    }
    expect(count).toBe(100)
  })
})
