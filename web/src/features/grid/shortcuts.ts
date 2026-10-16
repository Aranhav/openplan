// `userAgentData` is not in the DOM types yet; only Chromium browsers have it.
type NavigatorWithUserAgentData = Navigator & { userAgentData?: { platform?: string } }

/**
 * The name of the operating system: the user agent data's where the browser has it, since the
 * `platform` that every browser has is deprecated and its answer is not guaranteed.
 */
function platformName(): string {
  const { userAgentData, platform } = navigator as NavigatorWithUserAgentData
  return userAgentData?.platform || platform
}

/** Whether the keyboard is a Mac's, where Command takes the place of Ctrl. */
export function isMac(): boolean {
  return /^(mac|iphone|ipad|ipod|ios)/i.test(platformName())
}

/** How the shortcut of a letter is written: Ctrl+C, or ⌘C on a Mac. */
export function shortcut(letter: string): string {
  return isMac() ? `⌘${letter}` : `Ctrl+${letter}`
}

const ARROWS = {
  "row-collapse": "←",
  "row-expand": "→",
  "column-collapse": "↑",
  "column-expand": "↓",
} as const

/** How the keys that collapse or expand the member of the active row or column are written. */
export function collapseShortcut(axis: "row" | "column", expand: boolean): string {
  const arrow = ARROWS[`${axis}-${expand ? "expand" : "collapse"}`]
  return isMac() ? `⌥⇧${arrow}` : `Alt+Shift+${arrow}`
}
