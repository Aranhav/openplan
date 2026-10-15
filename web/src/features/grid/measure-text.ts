// Cells are 14 px text (Tailwind's text-sm).
const FONT_SIZE = 14
// What a character is taken to measure when there is no canvas to ask, in tests for one.
const FALLBACK_CHARACTER_WIDTH = 8
const MAX_CACHED = 5000

type MeasuringContext = Pick<CanvasRenderingContext2D, "font" | "measureText">

/**
 * A function that tells how wide a text is in the cell font at a weight (400 normal, 600
 * semibold, 700 bold), by asking a canvas once per distinct text and weight. Cells call it for
 * every number they show, so answers are kept.
 */
export function createTextMeasurer(
  getContext: () => MeasuringContext | null,
  getFamily: () => string,
): (text: string, weight: number) => number {
  const cache = new Map<string, number>()
  let context: MeasuringContext | null = null
  // Whether the context was asked for, so that having none is not asked again at every call.
  let asked = false
  let family: string | undefined

  return (text, weight) => {
    if (!asked) {
      asked = true
      context = getContext()
    }
    if (!context) {
      return text.length * FALLBACK_CHARACTER_WIDTH
    }
    const key = `${weight}|${text}`
    const known = cache.get(key)
    if (known !== undefined) {
      return known
    }
    family ??= getFamily()
    context.font = `${weight} ${FONT_SIZE}px ${family}`
    const width = context.measureText(text).width
    if (cache.size >= MAX_CACHED) {
      cache.clear()
    }
    cache.set(key, width)
    return width
  }
}

function canvasContext(): MeasuringContext | null {
  try {
    return document.createElement("canvas").getContext("2d")
  } catch {
    return null
  }
}

function pageFontFamily(): string {
  return getComputedStyle(document.body).fontFamily || "sans-serif"
}

export const measureTextWidth = createTextMeasurer(canvasContext, pageFontFamily)
