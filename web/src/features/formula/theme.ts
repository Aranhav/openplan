import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { tags } from "@lezer/highlight"

/** The colours of the tokens come from `--formula-*` in `index.css`, which differ for the light and the dark theme. */
export const formulaHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.lineComment, color: "var(--formula-comment)", fontStyle: "italic" },
    { tag: tags.string, color: "var(--formula-string)" },
    { tag: tags.number, color: "var(--formula-number)" },
    { tag: tags.keyword, color: "var(--formula-keyword)", fontWeight: "600" },
    { tag: tags.operatorKeyword, color: "var(--formula-modifier)", fontWeight: "600" },
    { tag: tags.function(tags.variableName), color: "var(--formula-function)" },
    { tag: tags.variableName, color: "var(--formula-name)" },
    { tag: tags.operator, color: "var(--formula-operator)" },
    { tag: [tags.bracket, tags.punctuation], color: "var(--formula-punctuation)" },
  ]),
)

const FONT = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)'
const LINE = "1.375rem"

/** The editor, its lists and tooltips in the colours and shapes of the rest of the app. */
export const formulaTheme = EditorView.theme({
  "&": {
    fontSize: "0.875rem",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: FONT,
    lineHeight: LINE,
    // The editor grows with the formula, to six lines, and scrolls from there.
    maxHeight: `calc(6 * ${LINE} + 0.75rem)`,
    overflow: "auto",
  },
  ".cm-content": { padding: "0.375rem 0.75rem", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "color-mix(in oklab, var(--ring) 40%, transparent)" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in oklab, var(--ring) 30%, transparent)",
    outline: "1px solid color-mix(in oklab, var(--ring) 60%, transparent)",
  },
  "&.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "color-mix(in oklab, var(--destructive) 25%, transparent)",
  },
  ".cm-tooltip": {
    border: "1px solid var(--border)",
    borderRadius: "calc(var(--radius) - 2px)",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    boxShadow: "0 4px 12px oklch(0 0 0 / 15%)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: FONT,
    fontSize: "0.8125rem",
    maxHeight: "15rem",
    minWidth: "14rem",
    padding: "0.25rem",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.25rem 0.5rem",
    borderRadius: "calc(var(--radius) - 4px)",
    lineHeight: "1.25rem",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionLabel": { flex: "none" },
  ".cm-completionDetail": {
    marginLeft: "auto",
    paddingLeft: "1rem",
    fontStyle: "normal",
    color: "var(--muted-foreground)",
    fontFamily: "var(--font-sans, system-ui, sans-serif)",
    fontSize: "0.75rem",
  },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
  ".cm-formulaKindIcon": { flex: "none", color: "var(--muted-foreground)" },
  ".cm-completionInfo": {
    padding: "0.5rem 0.75rem",
    maxWidth: "20rem",
    fontFamily: "var(--font-sans, system-ui, sans-serif)",
    fontSize: "0.8125rem",
    whiteSpace: "normal",
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--destructive)",
    textUnderlineOffset: "3px",
  },
  ".cm-tooltip-lint": { fontFamily: "var(--font-sans, system-ui, sans-serif)" },
  ".cm-diagnostic": { padding: "0.375rem 0.625rem", fontSize: "0.8125rem" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--destructive)" },
  ".cm-diagnosticAction": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
    borderRadius: "calc(var(--radius) - 4px)",
    padding: "0 0.5rem",
    marginLeft: "0.5rem",
  },
  ".cm-formulaSignature": {
    padding: "0.5rem 0.75rem",
    maxWidth: "24rem",
    fontFamily: "var(--font-sans, system-ui, sans-serif)",
    fontSize: "0.8125rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  ".cm-formulaSignature code": {
    fontFamily: FONT,
    fontWeight: "600",
    color: "var(--formula-function)",
  },
  ".cm-formulaSignature p": { margin: "0" },
  ".cm-formulaSignatureCount": { color: "var(--muted-foreground)", fontSize: "0.75rem" },
})
