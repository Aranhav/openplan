/**
 * The server locates a problem by byte offsets into the UTF-8 formula; the editor counts UTF-16
 * units, as strings do. This converts the one to the other.
 */

/** How many bytes a code point takes in UTF-8; a lone surrogate is replaced by U+FFFD, three bytes. */
function utf8Length(codePoint: number) {
  if (codePoint < 0x80) {
    return 1
  }
  if (codePoint < 0x800) {
    return 2
  }
  return codePoint < 0x10000 ? 3 : 4
}

/** The index in `text`, in UTF-16 units, of a byte offset; one inside a character is taken to its end. */
export function byteToUtf16(text: string, byteOffset: number) {
  let bytes = 0
  let index = 0
  for (const character of text) {
    if (bytes >= byteOffset) {
      break
    }
    bytes += utf8Length(character.codePointAt(0) ?? 0)
    index += character.length
  }
  return index
}

/** The text between two byte offsets of a formula, which is the part a problem is about. */
export function formulaSpan(formula: string, start: number, end: number) {
  return formula.slice(byteToUtf16(formula, start), byteToUtf16(formula, end))
}
