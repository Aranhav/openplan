import axe from "axe-core"

/**
 * What axe finds wrong with the page, as "rule: selector" lines. Contrast is left out: jsdom has no
 * layout or stylesheet, so it cannot judge it.
 */
export async function violations() {
  const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } })
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
  )
}
