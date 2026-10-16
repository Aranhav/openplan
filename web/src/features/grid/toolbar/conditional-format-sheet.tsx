import { zodResolver } from "@hookform/resolvers/zod"
import { ArrowDown, ArrowUp, ChevronsUpDown, Plus, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { type UseFormReturn, useFieldArray, useForm, useWatch } from "react-hook-form"
import { z } from "zod"
import { DiscardChangesDialog } from "@/components/discard-changes-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { lineItemsOf } from "@/features/structure/modules"
import type { LineItemDto, ModuleDto, StructureDto } from "@/features/structure/types"
import { useSheetDismiss } from "@/hooks/use-sheet-dismiss"
import { focusFirstField } from "@/lib/sheet-focus"
import { cn } from "@/lib/utils"
import type { FormatColor, FormatOp, ViewDefinition } from "../view-types"
import {
  COLOR_NAMES,
  FORMAT_COLORS,
  FORMAT_OPS,
  FORMAT_OP_LABELS,
  MAX_RULES,
  type RuleRow,
  newRule,
  ruleProblems,
  ruleRows,
  toFormats,
  valueCount,
} from "./format-rules"
import type { ViewAction } from "./view-state"

// Whole class names, because Tailwind only generates the ones it finds written out in full.
const SWATCH: Record<FormatColor, string> = {
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  muted: "bg-neutral-500",
}

const schema = z.object({
  rules: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Name is required.").max(80, "Name must be at most 80 characters."),
        line_item_ids: z.array(z.string()),
        op: z.enum(FORMAT_OPS as [FormatOp, ...FormatOp[]]),
        value: z.string(),
        value2: z.string(),
        color: z.enum(FORMAT_COLORS as [FormatColor, ...FormatColor[]]),
        bold: z.boolean(),
      }),
    )
    .superRefine((rules, ctx) => {
      rules.forEach((rule, index) => {
        for (const [field, message] of Object.entries(ruleProblems(rule))) {
          ctx.addIssue({ code: "custom", path: [index, field], message })
        }
      })
    }),
})

interface FormValues {
  rules: RuleRow[]
}

interface ConditionalFormatSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  module: ModuleDto
  structure: StructureDto
  view: ViewDefinition
  dispatch: (action: ViewAction) => void
  /** Called as the sheet closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * The rules that colour cells, in the order they are tried: of the rules that match a cell, the
 * first one applies. Edits are kept in the sheet until Apply, and dismissing it asks first.
 */
export function ConditionalFormatSheet({
  open,
  onOpenChange,
  module,
  structure,
  view,
  dispatch,
  onCloseAutoFocus,
}: ConditionalFormatSheetProps) {
  const { dirtyRef, dismiss, discard } = useSheetDismiss(onOpenChange, false)
  return (
    <>
      <Sheet open={open} onOpenChange={dismiss}>
        <SheetContent
          onOpenAutoFocus={focusFirstField}
          onCloseAutoFocus={onCloseAutoFocus}
          className="w-full gap-0 sm:max-w-xl"
        >
          <SheetHeader className="border-b pr-12">
            <SheetTitle>Conditional formatting</SheetTitle>
            <SheetDescription>
              Rules colour the cells of {module.name} that match them. Of the rules that match a
              cell, the first one applies.
            </SheetDescription>
          </SheetHeader>
          <RulesForm
            lineItems={lineItemsOf(structure, module.id)}
            formats={view.conditional_formats ?? []}
            dirtyRef={dirtyRef}
            onApply={(formats) => {
              dispatch({ type: "set_conditional_formats", formats })
              onOpenChange(false)
            }}
            onCancel={() => onOpenChange(false)}
          />
        </SheetContent>
      </Sheet>
      <DiscardChangesDialog
        description="Your changes to these rules have not been applied."
        {...discard}
      />
    </>
  )
}

interface RulesFormProps {
  lineItems: LineItemDto[]
  formats: NonNullable<ViewDefinition["conditional_formats"]>
  dirtyRef: { current: boolean }
  onApply: (formats: ReturnType<typeof toFormats>) => void
  onCancel: () => void
}

// A separate component, so the rules start from the view's each time the sheet opens.
function RulesForm({ lineItems, formats, dirtyRef, onApply, onCancel }: RulesFormProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { rules: ruleRows(formats) },
  })
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name: "rules" })
  const [announcement, setAnnouncement] = useState("")
  const { isDirty } = form.formState

  useEffect(() => {
    dirtyRef.current = isDirty
    return () => {
      dirtyRef.current = false
    }
  }, [dirtyRef, isDirty])

  function moveRule(index: number, by: -1 | 1) {
    const name = form.getValues(`rules.${index}.name`)
    move(index, index + by)
    setAnnouncement(`Moved ${name} to position ${index + by + 1} of ${fields.length}.`)
  }

  return (
    <Form {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => onApply(toFormats(values.rules)))}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          {fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rules yet. Add one to colour the cells that match it.
            </p>
          ) : (
            <ol aria-label="Rules" className="flex flex-col gap-3">
              {fields.map((field, index) => (
                <RuleCard
                  key={field.id}
                  form={form}
                  index={index}
                  count={fields.length}
                  lineItems={lineItems}
                  onMove={(by) => moveRule(index, by)}
                  onRemove={() => remove(index)}
                />
              ))}
            </ol>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={fields.length >= MAX_RULES}
              onClick={() => append(newRule(`Rule ${fields.length + 1}`))}
            >
              <Plus />
              Add rule
            </Button>
          </div>
        </div>
        <div role="status" className="sr-only">
          {announcement}
        </div>
        <SheetFooter className="flex-row justify-end border-t p-4">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit">Apply rules</Button>
        </SheetFooter>
      </form>
    </Form>
  )
}

interface RuleCardProps {
  form: UseFormReturn<FormValues>
  index: number
  count: number
  lineItems: LineItemDto[]
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}

function RuleCard({ form, index, count, lineItems, onMove, onRemove }: RuleCardProps) {
  const rule = useWatch({ control: form.control, name: `rules.${index}` })
  const number = index + 1
  const values = valueCount(rule.op)
  const scope =
    rule.line_item_ids.length === 0
      ? lineItems.filter((item) => item.format.type === "number")
      : lineItems.filter((item) => rule.line_item_ids.includes(item.id))
  const hasPercent = scope.some(
    (item) => item.format.type === "number" && item.format.unit.type === "percent",
  )

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-start gap-1.5">
        <FormField
          control={form.control}
          name={`rules.${index}.name`}
          render={({ field }) => (
            <FormItem className="min-w-0 flex-1 gap-1">
              <FormLabel>Name of rule {number}</FormLabel>
              <FormControl>
                <Input {...field} autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="mt-6 flex shrink-0 items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Move rule ${number} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Move rule ${number} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete rule ${number}`}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <FormField
        control={form.control}
        name={`rules.${index}.line_item_ids`}
        render={({ field }) => (
          <FormItem className="gap-1">
            <FormLabel>Line items of rule {number}</FormLabel>
            <LineItemsPicker
              label={`Line items of rule ${number}`}
              lineItems={lineItems}
              value={field.value}
              onChange={field.onChange}
            />
            <FormMessage />
          </FormItem>
        )}
      />
      <div className="flex items-start gap-2">
        <FormField
          control={form.control}
          name={`rules.${index}.op`}
          render={({ field }) => (
            <FormItem className="w-44 shrink-0 gap-1">
              <FormLabel>Condition of rule {number}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {FORMAT_OPS.map((op) => (
                    <SelectItem key={op} value={op}>
                      {FORMAT_OP_LABELS[op]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        {values >= 1 && (
          <FormField
            control={form.control}
            name={`rules.${index}.value`}
            render={({ field }) => (
              <FormItem className="min-w-0 flex-1 gap-1">
                <FormLabel>{values === 2 ? `From of rule ${number}` : `Value of rule ${number}`}</FormLabel>
                <FormControl>
                  <Input {...field} inputMode="decimal" autoComplete="off" className="h-8" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {values === 2 && (
          <FormField
            control={form.control}
            name={`rules.${index}.value2`}
            render={({ field }) => (
              <FormItem className="min-w-0 flex-1 gap-1">
                <FormLabel>To of rule {number}</FormLabel>
                <FormControl>
                  <Input {...field} inputMode="decimal" autoComplete="off" className="h-8" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
      </div>
      {hasPercent && values >= 1 && (
        <p className="-mt-1 text-xs text-muted-foreground">
          Percentages are compared as fractions: 0.05 is 5%.
        </p>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FormField
          control={form.control}
          name={`rules.${index}.color`}
          render={({ field }) => (
            <FormItem className="gap-1">
              <FormLabel id={`rule-color-${field.name}`}>Colour of rule {number}</FormLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={field.value}
                aria-labelledby={`rule-color-${field.name}`}
                onValueChange={(next) => {
                  // A group that lets go of its only choice would leave the rule without a colour.
                  if (next !== "") {
                    field.onChange(next)
                  }
                }}
              >
                {FORMAT_COLORS.map((color) => (
                  <ToggleGroupItem
                    key={color}
                    value={color}
                    aria-label={COLOR_NAMES[color]}
                    className="gap-0 px-2"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-3.5 rounded-full ring-offset-1 ring-offset-background [[data-state=on]_&]:ring-2 [[data-state=on]_&]:ring-ring",
                        SWATCH[color],
                      )}
                    />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name={`rules.${index}.bold`}
          render={({ field }) => (
            <FormItem className="flex items-center gap-2">
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <FormLabel>Bold for rule {number}</FormLabel>
            </FormItem>
          )}
        />
      </div>
    </li>
  )
}

interface LineItemsPickerProps {
  label: string
  lineItems: LineItemDto[]
  value: string[]
  onChange: (ids: string[]) => void
}

/** Chooses the line items a rule is for; none chosen is every line item with a number. */
function LineItemsPicker({ label, lineItems, value, onChange }: LineItemsPickerProps) {
  const chosen = lineItems.filter((item) => value.includes(item.id))
  const summary =
    chosen.length === 0
      ? "All number line items"
      : chosen.length <= 2
        ? chosen.map((item) => item.name).join(", ")
        : `${chosen.length} line items`
  const toggle = (id: string, checked: boolean) =>
    onChange(checked ? [...value, id] : value.filter((other) => other !== id))

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${label}: ${summary}`}
          className="w-full min-w-0 justify-between font-normal"
        >
          <span className="truncate">{summary}</span>
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={label} className="w-72 p-2">
        <ScrollArea className="[&_[data-slot=scroll-area-viewport]]:max-h-60">
          <ul className="flex flex-col">
            <li className="flex items-center gap-2 rounded-sm px-1 py-1.5 hover:bg-accent">
              <Checkbox
                id={`${label}-all`}
                checked={value.length === 0}
                onCheckedChange={(checked) => checked === true && onChange([])}
              />
              <Label htmlFor={`${label}-all`} className="flex-1">
                All number line items
              </Label>
            </li>
            {lineItems.map((item) => (
              <li key={item.id} className="flex items-center gap-2 rounded-sm px-1 py-1.5 hover:bg-accent">
                <Checkbox
                  id={`${label}-${item.id}`}
                  checked={value.includes(item.id)}
                  onCheckedChange={(checked) => toggle(item.id, checked === true)}
                />
                <Label htmlFor={`${label}-${item.id}`} className="min-w-0 flex-1 truncate">
                  {item.name}
                </Label>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
