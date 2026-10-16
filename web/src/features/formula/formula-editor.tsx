import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands"
import { bracketMatching } from "@codemirror/language"
import { forceLinting } from "@codemirror/lint"
import { Annotation, Compartment, EditorState, Prec } from "@codemirror/state"
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view"
import { useQueryClient } from "@tanstack/react-query"
import { type Ref, useEffect, useId, useImperativeHandle, useRef, useState } from "react"
import type { FormulaProblem } from "@/lib/api/client"
import { cn } from "@/lib/utils"
import { checkFormula, fetchCompletions, fetchFunctions } from "./api"
import { formulaAutocompletion } from "./completion"
import { FormulaProblems } from "./formula-problems"
import { formulaLanguage } from "./language"
import { type KnownProblems, formulaLinter } from "./lint"
import { signatureHelp } from "./signature"
import { formulaHighlight, formulaTheme } from "./theme"

/** What a form needs from the editor: to move the focus to it and to select a part of the formula. */
export interface FormulaEditorHandle {
  focus: () => void
  /** Selects from one index to another, in UTF-16 units, and scrolls them into view. */
  select: (from: number, to: number) => void
}

export interface FormulaEditorProps {
  modelId: string
  /** The line item the formula is for. Without it the server cannot be asked, so there are no completions or checks. */
  lineItemId?: string
  value: string
  onChange: (value: string) => void
  /** Enter. */
  onSubmit?: () => void
  /** Escape, when it has no list of completions to close. */
  onCancel?: () => void
  /** The formula can be read but not changed, and the editor takes no focus. */
  readOnly?: boolean
  /** What the server has already said is wrong with a formula (the saved one, or the one it refused). */
  known?: KnownProblems
  placeholder?: string
  "aria-label"?: string
  /** For a form control: the editor is the one element a label and a description point to. */
  id?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
  className?: string
  editorRef?: Ref<FormulaEditorHandle>
}

const NO_PROBLEMS: FormulaProblem[] = []

/** Marks a change that comes from the `value` prop, which is not an edit to report. */
const fromOutside = Annotation.define<boolean>()

function attributes({
  id,
  label,
  describedBy,
  invalid,
  readOnly,
}: {
  id?: string
  label?: string
  describedBy?: string
  invalid: boolean
  readOnly: boolean
}) {
  const found: Record<string, string> = {}
  if (id) found.id = id
  if (label) found["aria-label"] = label
  if (describedBy) found["aria-describedby"] = describedBy
  if (invalid) found["aria-invalid"] = "true"
  if (readOnly) found["aria-readonly"] = "true"
  return EditorView.contentAttributes.of(found)
}

/**
 * A formula in an editor: highlighted, completed from the model as it is typed, checked by the
 * server, with the signature of the function being called. One line that grows to six; Enter
 * submits, Shift+Enter breaks the line and Escape gives up.
 */
export function FormulaEditor({
  modelId,
  lineItemId,
  value,
  onChange,
  onSubmit,
  onCancel,
  readOnly = false,
  known,
  placeholder,
  "aria-label": ariaLabel,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  className,
  editorRef,
}: FormulaEditorProps) {
  const queryClient = useQueryClient()
  const problemsId = useId()
  const container = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [features] = useState(() => new Compartment())
  const [editable] = useState(() => new Compartment())
  const [labels] = useState(() => new Compartment())
  // What the effects below read, so that a new function from the parent does not rebuild the editor.
  const handlers = useRef({ onChange, onSubmit, onCancel, known })
  const [checked, setChecked] = useState<{ formula: string; problems: FormulaProblem[] }>()
  // The problems are those of the formula as it stands: what the server said of it already, or
  // what the last check said. They go from the list as the formula is edited, and come back once
  // it has been checked again. Nothing in the list depends on where the focus is, since a list
  // that appeared as the editor is left would move what a click was aimed at.
  const said = known && known.formula === value ? known : undefined
  const checkedNow = checked?.formula === value ? checked : undefined
  const problems = value.trim() === "" ? NO_PROBLEMS : (said ?? checkedNow)?.problems ?? NO_PROBLEMS
  const listed = problems.length > 0

  useEffect(() => {
    handlers.current = { onChange, onSubmit, onCancel, known }
  })

  useEffect(() => {
    const parent = host.current
    if (!parent) {
      return
    }
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.high(
            keymap.of([
              {
                key: "Enter",
                run: () => {
                  handlers.current.onSubmit?.()
                  return handlers.current.onSubmit !== undefined
                },
                shift: insertNewline,
              },
              {
                key: "Escape",
                run: () => {
                  handlers.current.onCancel?.()
                  return handlers.current.onCancel !== undefined
                },
              },
            ]),
          ),
          history(),
          closeBrackets(),
          bracketMatching(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          formulaLanguage,
          formulaHighlight,
          formulaTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((t) => t.annotation(fromOutside))) {
              handlers.current.onChange(update.state.doc.toString())
            }
          }),
          features.of([]),
          editable.of([]),
          labels.of([]),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
    // The editor is made once; what changes afterwards is sent to it by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: fromOutside.of(true),
      })
    }
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        editable.reconfigure([
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
          placeholder ? placeholderExtension(placeholder) : [],
        ]),
        labels.reconfigure(
          attributes({
            id,
            label: ariaLabel,
            describedBy: [describedBy, problems.length > 0 ? problemsId : undefined]
              .filter(Boolean)
              .join(" "),
            invalid: ariaInvalid === true || problems.length > 0,
            readOnly,
          }),
        ),
      ],
    })
  }, [readOnly, placeholder, id, ariaLabel, describedBy, ariaInvalid, problems.length, problemsId, editable, labels])

  useEffect(() => {
    // The server can only be asked about a line item, and only a builder may ask for a check.
    const editor = view.current
    if (!editor) {
      return
    }
    editor.dispatch({
      effects: features.reconfigure(
        readOnly
          ? []
          : [
              signatureHelp(() => fetchFunctions(queryClient)),
              ...(lineItemId
                ? [
                    formulaAutocompletion((prefix) =>
                      fetchCompletions(queryClient, modelId, lineItemId, prefix),
                    ),
                    formulaLinter({
                      check: (formula, signal) => checkFormula(modelId, lineItemId, formula, signal),
                      known: () => handlers.current.known,
                      onProblems: (formula, found) => setChecked({ formula, problems: found }),
                    }),
                  ]
                : []),
            ],
      ),
    })
  }, [queryClient, modelId, lineItemId, readOnly, features])

  useEffect(() => {
    if (view.current) {
      forceLinting(view.current)
    }
  }, [known])

  // A save the server refused is explained under the formula, which may be below the fold.
  const refused = said?.refused === true
  useEffect(() => {
    if (refused) {
      container.current?.scrollIntoView({ block: "nearest" })
    }
  }, [refused])

  useImperativeHandle(editorRef, () => ({
    focus: () => view.current?.focus(),
    select: (from, to) => {
      view.current?.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
      view.current?.focus()
    },
  }))

  return (
    <div ref={container} className={cn("flex flex-col gap-2", className)}>
      <div
        ref={host}
        data-slot="formula-editor"
        data-invalid={listed || ariaInvalid === true}
        data-readonly={readOnly}
        className="rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 data-[invalid=true]:border-destructive data-[invalid=true]:ring-destructive/20 data-[readonly=true]:bg-muted/40 dark:bg-input/30 dark:data-[invalid=true]:ring-destructive/40"
      />
      {problems.length > 0 && (
        <FormulaProblems
          id={problemsId}
          problems={problems}
          formula={value}
          announce={said?.refused}
        />
      )}
    </div>
  )
}
