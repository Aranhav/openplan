import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { type ReactNode, type RefObject, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { DiscardChangesDialog } from "@/components/discard-changes-dialog"
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
import { closeEditorPopupOnEscape } from "@/features/formula/escape"
import type { FormulaEditorHandle } from "@/features/formula/formula-editor"
import type { KnownProblems } from "@/features/formula/lint"
import { byteToUtf16 } from "@/features/formula/offsets"
import { useSheetDismiss } from "@/hooks/use-sheet-dismiss"
import { ApiError, type FormulaProblem } from "@/lib/api/client"
import { NAME_TAKEN_FIELD_ERRORS, reportFormError } from "@/lib/form-errors"
import { focusFirstField } from "@/lib/sheet-focus"
import { ClearValuesDialog } from "./clear-values-dialog"
import { FormulaField } from "./formula-field"
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
import { useSheetForm } from "./use-sheet-form"

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
  // Escape, a click outside and the close button ask before they lose edits; Cancel does not.
  const { dirtyRef, dismiss, discard } = useSheetDismiss(onOpenChange, update.isPending)

  return (
    <>
      <Sheet open={open} onOpenChange={dismiss}>
        <SheetContent
          onOpenAutoFocus={focusFirstField}
          // Escape closes the formula's list of completions, or its panel of problems, before it closes the sheet.
          onEscapeKeyDown={(event) => closeEditorPopupOnEscape(event) && event.preventDefault()}
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
            modelId={modelId}
            update={update}
            structure={structure}
            module={module}
            lineItem={lineItem}
            canEdit={canEdit}
            locked={locked}
            dirty={dirtyRef}
            onClose={() => onOpenChange(false)}
          />
        </SheetContent>
      </Sheet>
      <DiscardChangesDialog
        description="Your changes to this line item have not been saved."
        {...discard}
      />
    </>
  )
}

interface LineItemFormProps {
  modelId: string
  update: ReturnType<typeof useUpdateLineItem>
  structure: StructureDto
  module: ModuleDto
  lineItem: LineItemDto
  canEdit: boolean
  locked: boolean
  dirty: RefObject<boolean>
  onClose: () => void
}

function LineItemForm({
  modelId,
  update,
  structure,
  module,
  lineItem,
  canEdit,
  locked,
  dirty,
  onClose,
}: LineItemFormProps) {
  // The form follows the structure: a field nobody has touched takes the latest saved value (a
  // change from elsewhere shows up), a field being edited keeps what was typed.
  const form = useForm<LineItemValues>({
    resolver: zodResolver(lineItemSchema),
    values: lineItemValues(lineItem, module),
    resetOptions: { keepDirtyValues: true },
  })
  // What the server refused the formula for when it was last saved. The editor shows it for as
  // long as the formula is the one that was refused, and otherwise what the model says of the
  // saved formula, until it has checked the one being typed.
  const [refused, setRefused] = useState<{ formula: string; problems: FormulaProblem[] }>()
  const known: KnownProblems = refused
    ? { ...refused, refused: true }
    : { formula: lineItem.formula ?? "", problems: lineItem.formula_errors }
  // The values waiting for a yes to clearing the line item's input values.
  const [confirming, setConfirming] = useState<LineItemValues>()
  const { saveRef, markSaved, afterConfirmation } = useSheetForm(form, dirty)
  const formula = useRef<FormulaEditorHandle | null>(null)
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
      markSaved()
      onClose()
    } catch (error) {
      if (error instanceof ApiError && error.formulaErrors.length > 0) {
        showProblems(error, values.formula)
      } else {
        reportFormError(form, error, NAME_TAKEN_FIELD_ERRORS)
      }
    } finally {
      setConfirming(undefined)
    }
  }

  // Lists everything the server found, and selects the first problem in the formula.
  function showProblems(error: ApiError, text: string) {
    setRefused({ formula: text, problems: error.formulaErrors })
    form.setError("formula", { type: "server", message: error.detail })
    const [first] = error.formulaErrors
    formula.current?.select(byteToUtf16(text, first.start), byteToUtf16(text, first.end))
  }

  async function onSubmit(values: LineItemValues) {
    if (clearsInputValues(lineItem, values)) {
      setConfirming(values)
    } else {
      await save(values)
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
              modelId={modelId}
              lineItemId={lineItem.id}
              known={known}
              readOnly={disabled}
              onSubmit={() => void form.handleSubmit(onSubmit)()}
              editorRef={formula}
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
        onCloseAutoFocus={afterConfirmation}
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
