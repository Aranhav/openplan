import type { RowDimInfo } from "./grid-layout"
import { measureTextWidth } from "./measure-text"
import type { Member } from "./view-types"

// Headers are medium weight, and a summary is semibold; measuring everything as semibold keeps
// the widest label from being cut off.
const HEADER_WEIGHT = 600
// A dimension can have a hundred thousand members. The widest label is among the longest ones.
const CANDIDATES = 40

/**
 * What the members of a dimension say about how its row headers look, so that they can be sized
 * and indented before any row has loaded: how deep the hierarchy goes, whether any member has
 * children (so labels keep the room of a chevron), and how wide the widest label is.
 */
export function rowDimInfo(
  members: readonly Member[],
  measure: (text: string, weight: number) => number = measureTextWidth,
): RowDimInfo {
  let maxDepth = 0
  let collapsible = false
  for (const member of members) {
    maxDepth = Math.max(maxDepth, member.depth)
    collapsible ||= member.has_children
  }
  const longest = members
    .map((member) => member.label)
    .toSorted((a, b) => b.length - a.length)
    .slice(0, CANDIDATES)
  const labelWidth = longest.reduce((widest, label) => Math.max(widest, measure(label, HEADER_WEIGHT)), 0)
  return { maxDepth, collapsible, labelWidth }
}
