import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { type ReactNode, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { ProductionLock, ProductionNotice } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { useUpdateLineItem } from "@/features/structure/api"
import { lineItemsOf } from "@/features/structure/modules"
import type { LineItemDto, ModuleDto, StructureDto } from "@/features/structure/types"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { ApiError, type FormulaProblem } from "@/lib/api/client"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import { reportFormError } from "@/lib/form-errors"
import { ClearValuesDialog } from "./clear-values-dialog"
import { FormulaField } from "./formula-field"
import { formulaIndex } from "./formula-text"
import {
  type LineItemValues,
  clearsInputValues,
  lineItemPatch,
  lineItemSchema,
  lineItemValues,
} from "./line-item-form"
import { LineItemFormatFields } from "./line-item-format-fields"
import { LineItemScopeFields } from "./line-item-scope-fields"
import { LineItemSummaryFields } from "./line-item-summary-fields"

/** Where a refusal that carries only a code belongs: a name that is taken is about the name. */
const FIELD_ERRORS = { "structure.name_taken": "name" } as const

interface LineItemSheetProps {
  modelId: string
  structure: StructureDto
  module: ModuleDto
  lineItem: LineItemDto
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Whether the user may change the line item; if not, the settings are shown as they are. */
  canEdit: boolean
  /** Whether production mode switches the form off. */
  locked: boolean
  /** Called as the sheet closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

/** The settings of a line item, in a sheet beside the Blueprint. */
export function LineItemSheet({
  modelId,
  structure,
  module,
  lineItem,
  open,
  onOpenChange,
  canEdit,
  locked,
  onCloseAutoFocus,
}: LineItemSheetProps) {
  const update = useUpdateLineItem(modelId)
  return (
    <Sheet open={open} onOpenChange={closeUnlessBusy(update.isPending, onOpenChange)}>
      <SheetContent
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={!update.isPending}
        className="w-full gap-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Line item settings</SheetTitle>
          <SheetDescription>
            <span className="font-medium text-foreground">{lineItem.name}</span> in {module.name}.
            {!canEdit && " Only workspace builders and admins can change it."}
          </SheetDescription>
        </SheetHeader>
        <LineItemForm
          key={lineItem.id}
          update={update}
          structure={structure}
          module={module}
          lineItem={lineItem}
          canEdit={canEdit}
          locked={locked}
          onClose={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  )
}

interface LineItemFormProps {
  update: ReturnType<typeof useUpdateLineItem>
  structure: StructureDto
  module: ModuleDto
  lineItem: LineItemDto
  canEdit: boolean
  locked: boolean
  onClose: () => void
}

function LineItemForm({
  update,
  structure,
  module,
  lineItem,
  canEdit,
  locked,
  onClose,
}: LineItemFormProps) {
  // The form follows the structure: a field nobody has touched takes the latest saved value (a
  // change from elsewhere shows up), a field being edited keeps what was typed.
  const form = useForm<LineItemValues>({
    resolver: zodResolver(lineItemSchema),
    values: lineItemValues(lineItem, module),
    resetOptions: { keepDirtyValues: true },
  })
  const [problems, setProblems] = useState<FormulaProblem[]>([])
  // The values waiting for a yes to clearing the line item's input values.
  const [confirming, setConfirming] = useState<LineItemValues>()
  const { ref: saveRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const formula = useRef<HTMLTextAreaElement | null>(null)
  // Set once the line item is saved, when the sheet closing takes focus where it belongs.
  const saved = useRef(false)
  const disabled = !canEdit || locked

  const ratioParts = lineItemsOf(structure, module.id).filter(
    (item) => item.id !== lineItem.id && item.format.type === "number",
  )

  async function save(values: LineItemValues) {
    const patch = lineItemPatch(lineItem, values)
    try {
      if (Object.keys(patch).length > 0) {
        await update.mutateAsync({ lineItemId: lineItem.id, body: patch })
        toast.success("Line item saved")
      }
      saved.current = true
      onClose()
    } catch (error) {
      if (error instanceof ApiError && error.formulaErrors.length > 0) {
        showProblems(error, values.formula)
      } else {
        reportFormError(form, error, FIELD_ERRORS)
      }
    } finally {
      setConfirming(undefined)
    }
  }

  // Lists everything the server found, and selects the first problem in the formula.
  function showProblems(error: ApiError, text: string) {
    setProblems(error.formulaErrors)
    form.setError("formula", { type: "server", message: error.detail })
    const [first] = error.formulaErrors
    formula.current?.focus()
    formula.current?.setSelectionRange(
      formulaIndex(text, first.start),
      formulaIndex(text, first.end),
    )
  }

  async function onSubmit(values: LineItemValues) {
    if (clearsInputValues(lineItem, values)) {
      setConfirming(values)
    } else {
      await save(values)
    }
  }

  // Back to the save button, or if the server refused a field to that field, which is on screen
  // again once the dialog is gone.
  function afterDialog(event: Event) {
    if (saved.current) {
      event.preventDefault()
      return
    }
    const refused = Object.keys(form.formState.errors)[0] as keyof LineItemValues | undefined
    if (refused) {
      event.preventDefault()
      form.setFocus(refused)
    } else {
      restoreFocus(event)
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
        noValidate
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
          {locked && <ProductionNotice />}
          <Section title="General">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" disabled={disabled} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Code</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" disabled={disabled} {...field} />
                  </FormControl>
                  <FormDescription>A short code for the line item. Optional.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </Section>
          <Separator />
          <Section title="Format">
            <LineItemFormatFields form={form} structure={structure} disabled={disabled} />
          </Section>
          <Separator />
          <Section title="Calculation">
            <FormulaField
              form={form}
              problems={problems}
              onEdit={() => setProblems([])}
              readOnly={disabled}
              textareaRef={formula}
            />
            <LineItemSummaryFields
              form={form}
              ratioParts={ratioParts}
              hasTime={module.axes.some((axis) => axis.kind === "time")}
              disabled={disabled}
            />
          </Section>
          <Separator />
          <Section title="Dimensions">
            <LineItemScopeFields
              form={form}
              module={module}
              structure={structure}
              disabled={disabled}
            />
          </Section>
          <Separator />
          <Section title="Notes">
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="sr-only">Notes</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="What this line item is for"
                      disabled={disabled}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </Section>
        </div>
        <SheetFooter className="flex-row justify-end border-t">
          <Button type="button" variant="outline" disabled={update.isPending} onClick={onClose}>
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit && (
            <ProductionLock locked={locked}>
              <Button
                ref={saveRef}
                type="submit"
                disabled={locked || !form.formState.isDirty || update.isPending}
              >
                {update.isPending && <Loader2 className="animate-spin" />}
                Save changes
              </Button>
            </ProductionLock>
          )}
        </SheetFooter>
      </form>
      <ClearValuesDialog
        open={confirming !== undefined}
        description="This clears the line item's input values."
        pending={update.isPending}
        onConfirm={() => confirming && void save(confirming)}
        onOpenChange={(next) => !next && setConfirming(undefined)}
        onCloseAutoFocus={afterDialog}
      />
    </Form>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}
