/** A header cell a pointer is over: which axis, which dimension of it, and the row or column. */
export type HeaderTarget = { axis: "row" | "column"; level: number; index: number }

/**
 * The header a pointer event is over, if it is over one. Header cells say what they are in
 * `data-header-axis` and `data-header-level`; a column header also says its first column in
 * `data-header-index`, a row header is in a row that says its number in `data-row-index`.
 */
export function headerOf(target: EventTarget | null): HeaderTarget | undefined {
  const header =
    target instanceof Element ? target.closest<HTMLElement>("[data-header-axis]") : null
  if (!header) {
    return undefined
  }
  const level = Number(header.dataset.headerLevel)
  if (header.dataset.headerAxis === "column") {
    return { axis: "column", level, index: Number(header.dataset.headerIndex) }
  }
  const row = header.closest<HTMLElement>("[data-row-index]")
  return row ? { axis: "row", level, index: Number(row.dataset.rowIndex) } : undefined
}
