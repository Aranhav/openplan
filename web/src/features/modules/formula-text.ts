/** The text between two byte positions of a formula, which is where the server locates a problem. */
export function formulaSpan(formula: string, start: number, end: number) {
  const bytes = new TextEncoder().encode(formula)
  return new TextDecoder().decode(bytes.slice(start, end))
}

/** The index in `formula` (in UTF-16 units, which a text field counts in) of a byte position. */
export function formulaIndex(formula: string, byteOffset: number) {
  const bytes = new TextEncoder().encode(formula)
  return new TextDecoder().decode(bytes.slice(0, byteOffset)).length
}
