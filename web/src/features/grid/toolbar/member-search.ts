import type { Member } from "../view-types"

/** The most members a list shows at once: a dimension can have a hundred thousand. */
export const MAX_LISTED = 100

/** The members whose label has `query` in it, ignoring case, in their order. All of them for a blank query. */
export function membersMatching(members: readonly Member[], query: string): Member[] {
  const wanted = query.trim().toLowerCase()
  return wanted === ""
    ? [...members]
    : members.filter((member) => member.label.toLowerCase().includes(wanted))
}
