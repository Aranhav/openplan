import axe from "axe-core"

interface ViolationsOptions {
  /** What to check; the whole page by default. */
  context?: Element
  /** Rules to leave out besides colour contrast, such as `region` for a fragment of a page. */
  ignore?: string[]
}

/**
 * What axe finds wrong, as "rule: selector" lines. Contrast is always left out: jsdom has no
 * layout or stylesheet, so it cannot judge it.
 */
export async function violations({ context = document.body, ignore = [] }: ViolationsOptions = {}) {
  const rules = Object.fromEntries(
    ["color-contrast", ...ignore].map((rule) => [rule, { enabled: false }]),
  )
  const results = await axe.run(context, { rules })
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
  )
}
