/** A copy of `set` with `ids` in it (`present`) or without them. */
export function withIds(
  set: ReadonlySet<string>,
  ids: Iterable<string>,
  present: boolean,
): Set<string> {
  const next = new Set(set)
  for (const id of ids) {
    if (present) {
      next.add(id)
    } else {
      next.delete(id)
    }
  }
  return next
}

/** Whether both hold the same ids. */
export function sameIds(a: ReadonlySet<string>, b: Iterable<string>): boolean {
  const other = new Set(b)
  return a.size === other.size && [...a].every((id) => other.has(id))
}
