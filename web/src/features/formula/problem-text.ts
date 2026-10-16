/** How many problems a formula has, in a sentence. */
export function problemCountText(count: number) {
  return count === 1 ? "The formula has a problem." : `The formula has ${count} problems.`
}

/** What a screen reader is told when a check finds this many problems, in other words than the list's, which says the same to the eye. */
export function checkResultText(count: number) {
  if (count === 0) {
    return "Checked: no problems found."
  }
  return count === 1 ? "Checked: 1 problem found." : `Checked: ${count} problems found.`
}
