import { CircleAlert } from "lucide-react"
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
import { Textarea } from "@/components/ui/textarea"
import type { FormulaProblem } from "@/lib/api/client"
import { formulaSpan } from "./formula-text"
import type { LineItemValues } from "./line-item-form"

interface FormulaFieldProps {
  form: UseFormReturn<LineItemValues>
  /** What the server found wrong with the formula the last time it was saved. */
  problems: FormulaProblem[]
  /** The formula was edited, which makes what the server said about it out of date. */
  onEdit: () => void
  /** The formula can be read and copied but not changed. */
  readOnly?: boolean
  textareaRef: Ref<HTMLTextAreaElement>
}

/** The formula of a line item, typed in a monospace field, with every problem the server finds in it listed below. */
export function FormulaField({ form, problems, onEdit, readOnly, textareaRef }: FormulaFieldProps) {
  return (
    <FormField
      control={form.control}
      name="formula"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Formula</FormLabel>
          <FormControl>
            <Textarea
              {...field}
              ref={(element) => {
                field.ref(element)
                if (typeof textareaRef === "function") {
                  textareaRef(element)
                } else if (textareaRef) {
                  textareaRef.current = element
                }
              }}
              onChange={(event) => {
                field.onChange(event)
                onEdit()
              }}
              rows={4}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              readOnly={readOnly}
              className="font-mono text-sm"
              placeholder="Revenue * Margin"
            />
          </FormControl>
          <FormDescription>
            Leave it empty to type the values in yourself. A line item with a formula is calculated.
          </FormDescription>
          <FormulaMessage problems={problems} formula={field.value} />
        </FormItem>
      )}
    />
  )
}

function FormulaMessage({ problems, formula }: { problems: FormulaProblem[]; formula: string }) {
  const { error, formMessageId } = useFormField()
  if (problems.length === 0) {
    return error ? (
      <p id={formMessageId} className="text-sm text-destructive">
        {String(error.message ?? "")}
      </p>
    ) : null
  }
  return (
    <div id={formMessageId} role="alert" className="flex flex-col gap-2 text-sm text-destructive">
      <p className="font-medium">
        {problems.length === 1
          ? "The formula has a problem."
          : `The formula has ${problems.length} problems.`}
      </p>
      <ul className="flex flex-col gap-2">
        {problems.map((problem, index) => {
          const span = formulaSpan(formula, problem.start, problem.end)
          return (
            <li key={index} className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">
                {problem.message}
                {span && !problem.message.includes(span) && (
                  <>
                    {" "}
                    <code className="rounded-sm bg-destructive/10 px-1 py-0.5 font-mono text-xs">
                      {span}
                    </code>
                  </>
                )}
                {problem.suggestion && (
                  <span className="block text-muted-foreground">
                    Did you mean <code className="font-mono text-xs">{problem.suggestion}</code>?
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
