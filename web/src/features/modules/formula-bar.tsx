import { Loader2 } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { FormulaEditor, type FormulaEditorHandle } from "@/features/formula/formula-editor"
import type { KnownProblems } from "@/features/formula/lint"
import { byteToUtf16 } from "@/features/formula/offsets"
import { useUpdateLineItem } from "@/features/structure/api"
import type { LineItemDto } from "@/features/structure/types"
import { ApiError, type FormulaProblem, errorDetail } from "@/lib/api/client"
import { ClearValuesDialog } from "./clear-values-dialog"

interface FormulaBarProps {
  modelId: string
  /** The line item whose formula the bar shows; none until one is selected. */
  lineItem: LineItemDto | undefined
  /** Whether the signed-in user may change formulas. */
  canEdit: boolean
  /** Whether production mode switches changing them off. */
  locked: boolean
}

/** The formula the server refused to save, and what it found wrong in it. */
interface Refusal {
  lineItemId: string
  formula: string
  problems: FormulaProblem[]
}

function without(drafts: Record<string, string>, id: string) {
  const rest = { ...drafts }
  delete rest[id]
  return rest
}

/**
 * The formula of the selected line item, above the Blueprint and the grid, to read and, for a
 * builder, to change: Enter or Save saves it, Escape or Cancel gives up the change. What was typed
 * for each line item is kept while another is selected, until it is saved or given up. A formula
 * for an input line item is confirmed first, since it clears the values typed into the line item.
 */
export function FormulaBar({ modelId, lineItem, canEdit, locked }: FormulaBarProps) {
  const update = useUpdateLineItem(modelId)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [refusal, setRefusal] = useState<Refusal>()
  // The formula waiting for a yes to clearing the line item's input values.
  const [confirming, setConfirming] = useState<string>()
  const editor = useRef<FormulaEditorHandle | null>(null)
  const readOnly = !canEdit || locked

  if (!lineItem) {
    return (
      <Bar label="fx">
        <p className="py-1.5 text-sm text-muted-foreground">
          Select a line item to see its formula.
        </p>
      </Bar>
    )
  }

  const saved = lineItem.formula ?? ""
  const draft = drafts[lineItem.id]
  const value = draft ?? saved
  const dirty = draft !== undefined
  const known: KnownProblems =
    refusal?.lineItemId === lineItem.id
      ? { formula: refusal.formula, problems: refusal.problems, refused: true }
      : { formula: saved, problems: lineItem.formula_errors }

  function edit(id: string, text: string) {
    setDrafts((now) => (text === saved ? without(now, id) : { ...now, [id]: text }))
  }

  function cancel() {
    setDrafts((now) => without(now, lineItem?.id ?? ""))
    setRefusal(undefined)
  }

  function submit() {
    if (!lineItem || !dirty || update.isPending) {
      return
    }
    if (!lineItem.formula && value.trim() !== "") {
      setConfirming(value)
    } else {
      void save(value)
    }
  }

  async function save(text: string) {
    if (!lineItem) {
      return
    }
    const { id } = lineItem
    try {
      await update.mutateAsync({ lineItemId: id, body: { formula: text.trim() === "" ? null : text } })
      toast.success("Formula saved")
      setDrafts((now) => without(now, id))
      setRefusal(undefined)
    } catch (error) {
      if (error instanceof ApiError && error.formulaErrors.length > 0) {
        setRefusal({ lineItemId: id, formula: text, problems: error.formulaErrors })
        const [first] = error.formulaErrors
        editor.current?.select(byteToUtf16(text, first.start), byteToUtf16(text, first.end))
      } else {
        toast.error(errorDetail(error))
      }
    } finally {
      setConfirming(undefined)
    }
  }

  return (
    <Bar label="fx" name={lineItem.name}>
      <FormulaEditor
        key={lineItem.id}
        className="min-w-0 flex-1"
        modelId={modelId}
        lineItemId={lineItem.id}
        aria-label={`Formula of ${lineItem.name}`}
        placeholder={
          readOnly
            ? "No formula: this line item holds typed values."
            : "Type a formula to calculate this line item."
        }
        value={value}
        onChange={(text) => edit(lineItem.id, text)}
        onSubmit={submit}
        onCancel={cancel}
        readOnly={readOnly}
        known={known}
        editorRef={editor}
      />
      {dirty && !readOnly && (
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" disabled={update.isPending} onClick={cancel}>
            Cancel
          </Button>
          <Button type="button" disabled={update.isPending} onClick={submit}>
            {update.isPending && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </div>
      )}
      <ClearValuesDialog
        open={confirming !== undefined}
        description="This clears the line item's input values."
        pending={update.isPending}
        onConfirm={() => confirming !== undefined && void save(confirming)}
        onOpenChange={(next) => !next && setConfirming(undefined)}
      />
    </Bar>
  )
}

function Bar({
  label,
  name,
  children,
}: {
  label: string
  name?: string
  children: React.ReactNode
}) {
  return (
    <div
      role="group"
      aria-label="Formula bar"
      className="flex flex-col gap-2 rounded-lg border bg-card p-2 sm:flex-row sm:items-start"
    >
      <div className="flex shrink-0 items-center gap-2 sm:h-9">
        <span aria-hidden className="w-6 text-center font-mono text-sm font-semibold italic text-muted-foreground">
          {label}
        </span>
        {name && (
          <span className="max-w-48 truncate text-sm font-medium" title={name}>
            {name}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}
