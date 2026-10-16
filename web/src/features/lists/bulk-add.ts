import type { ItemDto, ItemInput } from "./types"

/** The longest name of an item, as the server counts it: in characters. */
const NAME_MAX = 80

export interface BulkLineError {
  /** The line of the text, counting from 1 and counting the blank lines. */
  line: number
  message: string
}

export interface BulkResult {
  /** An item for each line that has one, in order. */
  items: ItemInput[]
  /** The line of the text each of the `items` came from. */
  lines: number[]
  errors: BulkLineError[]
}

interface BulkOptions {
  /** The items the list has already. */
  existing: ItemDto[]
  /** Whether names may repeat: in a numbered list items are told apart by their code. */
  numbered: boolean
  /** The items of the parent list, when the list has one: each line then ends with its parent. */
  parents?: ItemDto[]
  /** The name of the parent list, for the messages. */
  parentList?: string
}

/** How many lines of the text have something on them. */
export function countLines(text: string) {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").length
}

const NEEDS_PARENT = "Add a parent after a comma, as in “Name, Parent”."

/** The item a name or a code points to: a name, whatever its case, before a code, which must match exactly. */
function parentFinder(parents: ItemDto[]) {
  const byName = new Map<string, string>()
  const byCode = new Map<string, string>()
  for (const parent of parents) {
    const name = parent.name.toLowerCase()
    if (!byName.has(name)) {
      byName.set(name, parent.id)
    }
    if (parent.code && !byCode.has(parent.code)) {
      byCode.set(parent.code, parent.id)
    }
  }
  return (text: string) => byName.get(text.toLowerCase()) ?? byCode.get(text)
}

/**
 * Reads a pasted block of text with one item on each line: `Name`, or `Name, Parent` when the list
 * has a parent list (the parent is named by its name or its code, and the last comma divides them,
 * so a name may hold commas). Every line is checked, so the errors cover all the lines at once.
 */
export function parseBulkAdd(text: string, options: BulkOptions): BulkResult {
  const { existing, numbered, parents, parentList } = options
  const findParent = parents && parentFinder(parents)
  const taken = new Map<string, number>()
  const used = new Set(existing.map((item) => item.name.toLowerCase()))
  const result: BulkResult = { items: [], lines: [], errors: [] }

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    if (raw.trim() === "") {
      return
    }
    const fail = (message: string) => result.errors.push({ line, message })

    let name = raw.trim()
    let parentId: string | undefined
    if (findParent) {
      const comma = raw.lastIndexOf(",")
      const parentText = comma < 0 ? "" : raw.slice(comma + 1).trim()
      if (parentText === "") {
        fail(NEEDS_PARENT)
        return
      }
      name = raw.slice(0, comma).trim()
      parentId = findParent(parentText)
      if (name !== "" && parentId === undefined) {
        fail(`${parentText} is not an item of ${parentList ?? "the parent list"}.`)
        return
      }
    }
    if (name === "") {
      fail("Name is required.")
      return
    }
    if ([...name].length > NAME_MAX) {
      fail(`Name must be at most ${NAME_MAX} characters.`)
      return
    }
    if (!numbered) {
      const key = name.toLowerCase()
      const earlier = taken.get(key)
      if (earlier !== undefined) {
        fail(`${name} is already on line ${earlier}.`)
        return
      }
      if (used.has(key)) {
        fail(`${name} is already in the list.`)
        return
      }
      taken.set(key, line)
    }
    result.items.push({ name, ...(parentId !== undefined && { parent_id: parentId }) })
    result.lines.push(line)
  })
  return result
}
