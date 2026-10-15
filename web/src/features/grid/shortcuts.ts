/** Whether the keyboard is a Mac's, where Command takes the place of Ctrl. */
export function isMac(): boolean {
  return /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform)
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
