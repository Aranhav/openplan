import type { Ref } from "react"
import type { UseFormReturn } from "react-hook-form"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  useFormField,
} from "@/components/ui/form"
import {
  FormulaEditor,
  type FormulaEditorHandle,
} from "@/features/formula/formula-editor"
import type { KnownProblems } from "@/features/formula/lint"
import type { LineItemValues } from "./line-item-form"

interface FormulaFieldProps {
  form: UseFormReturn<LineItemValues>
  modelId: string
  lineItemId: string
  /** What the server says is wrong with the saved formula, or with the one it just refused. */
  known: KnownProblems
  /** The formula can be read and copied but not changed. */
  readOnly?: boolean
  /** Enter in the formula saves the line item, as it does in the other fields. */
  onSubmit: () => void
  editorRef: Ref<FormulaEditorHandle>
}

/** The formula of a line item, in the formula editor, with every problem found in it listed below. */
export function FormulaField({
  form,
  modelId,
  lineItemId,
  known,
  readOnly,
  onSubmit,
  editorRef,
}: FormulaFieldProps) {
  return (
    <FormField
      control={form.control}
      name="formula"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Formula</FormLabel>
          <FormControl>
            <FormulaEditor
              modelId={modelId}
              lineItemId={lineItemId}
              aria-label="Formula"
              placeholder="Revenue * Margin"
              value={field.value}
              onChange={field.onChange}
              onSubmit={onSubmit}
              readOnly={readOnly}
              known={known}
              editorRef={(handle) => {
                // The form moves the focus to a field it refused, through the ref it was given.
                field.ref(handle)
                if (typeof editorRef === "function") {
                  editorRef(handle)
                } else if (editorRef) {
                  editorRef.current = handle
                }
              }}
            />
          </FormControl>
          <FormDescription>
            Leave it empty to type the values in yourself. A line item with a formula is calculated.
          </FormDescription>
          <FormulaFormMessage />
        </FormItem>
      )}
    />
  )
}

/** What the form itself finds wrong with the formula; the server's refusal is shown by the editor. */
function FormulaFormMessage() {
  const { error, formMessageId } = useFormField()
  if (!error || error.type === "server") {
    return null
  }
  return (
    <p id={formMessageId} className="text-sm text-destructive">
      {String(error.message ?? "")}
    </p>
  )
}
