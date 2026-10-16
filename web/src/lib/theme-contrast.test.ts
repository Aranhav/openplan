/// <reference types="node" />
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Vitest leaves stylesheets out of what it imports, so the file is read as it is on disk.
const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8")

/** The declarations of the first rule with this selector, as name to value. */
function declarationsOf(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`)
  const end = css.indexOf("\n}", start)
  const declarations = new Map<string, string>()
  for (const [, name, value] of css.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    declarations.set(name, value.trim())
  }
  return declarations
}

/** The colour of a token as linear sRGB, from the `oklch(L C H)` it is written as. */
function linearRgb(value: string): [number, number, number] {
  const [, lightness, chroma, hue] = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value) ?? []
  if (lightness === undefined) {
    throw new Error(`Expected an oklch() colour without alpha, got ${value}`)
  }
  const a = Number(chroma) * Math.cos((Number(hue) * Math.PI) / 180)
  const b = Number(chroma) * Math.sin((Number(hue) * Math.PI) / 180)
  const l = (Number(lightness) + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (Number(lightness) - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (Number(lightness) - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (channel: number) => Math.min(1, Math.max(0, channel))
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function luminance(value: string) {
  const [r, g, b] = linearRgb(value)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The WCAG contrast ratio of two tokens' colours. */
function contrast(foreground: string, background: string) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

// Text in the muted colour is drawn on every surface of the app: the page, cards and popovers, and
// the muted, secondary and accent fills of avatars, key hints, hovered and selected rows.
const SURFACES = ["--background", "--card", "--popover", "--muted", "--secondary", "--accent"]

describe.each([
  [":root", "light"],
  [".dark", "dark"],
])("the muted text colour in the %s theme", (selector, theme) => {
  const tokens = declarationsOf(selector)

  it.each(SURFACES)(`reads on %s at the 4.5:1 that WCAG AA asks of text (${theme})`, (surface) => {
    const text = tokens.get("--muted-foreground") as string
    const fill = tokens.get(surface) as string

    expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5)
  })
})
