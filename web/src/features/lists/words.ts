/** "1 item", "12 items": the count with a thousands separator, and the noun in the plural unless it is one. */
export function countOf(count: number, noun: string) {
  return `${count.toLocaleString("en")} ${count === 1 ? noun : `${noun}s`}`
}
