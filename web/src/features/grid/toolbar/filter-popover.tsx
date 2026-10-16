import { zodResolver } from "@hookform/resolvers/zod"
import { Filter, Plus, Trash2 } from "lucide-react"
import type { RefObject } from "react"
import { useFieldArray, useForm, useWatch } from "react-hook-form"
import { z } from "zod"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { lineItemsOf } from "@/features/structure/modules"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import type { GridReference } from "../edit-reference"
import type { Format } from "../core/types"
import type { RowFilter, ViewDefinition } from "../view-types"
import {
  type FilterRow,
  OPERATOR_LABELS,
  defaultRow,
  needsValue,
  operatorsFor,
  placeholderFor,
  rowOf,
  toFilter,
} from "./filter-rows"
import { ToolbarPanel } from "./toolbar-panel"
import type { ViewAction } from "./view-state"

/** The most filters a view has, which the server allows. */
const MAX_FILTERS = 10

const TEXT: Format = { type: "text" }

interface FilterPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Where the panel hangs when the filter button has moved into the More menu. */
  anchor?: RefObject<HTMLElement | null>
  module: ModuleDto
  structure: StructureDto
  view: ViewDefinition
  reference: GridReference
  dispatch: (action: ViewAction) => void
}

/** Conditions on the rows: a line item, how its value is compared and with what. Rows that fail any are left out. */
export function FilterPopover({
  open,
  onOpenChange,
  anchor,
  module,
  structure,
  view,
  reference,
  dispatch,
}: FilterPopoverProps) {
  const count = view.filters?.length ?? 0
  const trigger = anchor ? undefined : (
    <Button
      variant={count > 0 ? "secondary" : "ghost"}
      size="sm"
      aria-label={count > 0 ? `Filter, ${count} active` : undefined}
      className="gap-1.5 px-2"
    >
      <Filter />
      Filter
      {count > 0 && (
        <Badge variant="outline" className="h-4 min-w-4 px-1">
          {count}
        </Badge>
      )}
    </Button>
  )
  return (
    <ToolbarPanel
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      anchor={anchor}
      label="Filter rows"
      className="w-[26rem]"
    >
      <FilterForm
        module={module}
        structure={structure}
        filters={view.filters ?? []}
        reference={reference}
        onApply={(filters) => {
          dispatch({ type: "set_filters", filters })
          onOpenChange(false)
        }}
      />
    </ToolbarPanel>
  )
}

interface FilterValues {
  rows: FilterRow[]
}

interface FilterFormProps {
  module: ModuleDto
  structure: StructureDto
  filters: readonly RowFilter[]
  reference: GridReference
  onApply: (filters: RowFilter[]) => void
}

// A separate component, so the rows start from the filters in force each time the panel opens.
function FilterForm({ module, structure, filters, reference, onApply }: FilterFormProps) {
  const lineItems = lineItemsOf(structure, module.id)
  const formats = new Map(lineItems.map((item) => [item.id, item.format]))
  const schema = z.object({ rows: z.array(z.custom<FilterRow>()) }).superRefine((values, ctx) => {
    values.rows.forEach((row, index) => {
      const result = toFilter(row, formats.get(row.line_item), reference)
      if ("message" in result) {
        ctx.addIssue({ code: "custom", path: ["rows", index, result.field], message: result.message })
      }
    })
  })
  const form = useForm<FilterValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      rows: filters.map((filter) =>
        rowOf(filter, formats.get(filter.line_item) ?? TEXT, reference),
      ),
    },
  })
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "rows" })
  const rows = useWatch({ control: form.control, name: "rows" })

  function onSubmit(values: FilterValues) {
    onApply(
      values.rows.flatMap((row) => {
        const result = toFilter(row, formats.get(row.line_item), reference)
        return "filter" in result ? [result.filter] : []
      }),
    )
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Filter rows</h2>
        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No filters. Add one to show only the rows that pass it.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {fields.map((field, index) => {
              const row = rows[index] ?? field
              const format = formats.get(row.line_item)
              return (
                <li key={field.id} className="flex flex-col gap-1.5 rounded-md border p-2">
                  <div className="flex items-start gap-1.5">
                    <FormField
                      control={form.control}
                      name={`rows.${index}.line_item`}
                      render={({ field: item }) => (
                        <FormItem className="min-w-0 flex-1 gap-1">
                          <FormLabel className="sr-only">Line item of filter {index + 1}</FormLabel>
                          <Select
                            value={item.value}
                            onValueChange={(next) => {
                              item.onChange(next)
                              const nextFormat = formats.get(next)
                              if (nextFormat) {
                                form.setValue(`rows.${index}.op`, defaultRow(next, nextFormat).op)
                                form.setValue(`rows.${index}.text`, "")
                              }
                            }}
                          >
                            <FormControl>
                              <SelectTrigger size="sm" className="w-full">
                                <SelectValue placeholder="Line item" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {lineItems.map((lineItem) => (
                                <SelectItem key={lineItem.id} value={lineItem.id}>
                                  {lineItem.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove filter ${index + 1}`}
                      onClick={() => remove(index)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <FormField
                      control={form.control}
                      name={`rows.${index}.op`}
                      render={({ field: op }) => (
                        <FormItem className="w-40 shrink-0 gap-1">
                          <FormLabel className="sr-only">Condition of filter {index + 1}</FormLabel>
                          <Select value={op.value} onValueChange={op.onChange} disabled={!format}>
                            <FormControl>
                              <SelectTrigger size="sm" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {(format ? operatorsFor(format) : []).map((name) => (
                                <SelectItem key={name} value={name}>
                                  {OPERATOR_LABELS[name]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {needsValue(row.op) && (
                      <FormField
                        control={form.control}
                        name={`rows.${index}.text`}
                        render={({ field: value }) => (
                          <FormItem className="min-w-0 flex-1 gap-1">
                            <FormLabel className="sr-only">Value of filter {index + 1}</FormLabel>
                            <FormControl>
                              <Input
                                {...value}
                                autoComplete="off"
                                placeholder={format ? placeholderFor(format, row.op) : ""}
                                className="h-8"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={fields.length >= MAX_FILTERS || lineItems.length === 0}
            onClick={() => append(defaultRow(lineItems[0].id, lineItems[0].format))}
          >
            <Plus />
            Add filter
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={fields.length === 0 && filters.length === 0}
              onClick={() => onApply([])}
            >
              Clear
            </Button>
            <Button type="submit" size="sm">
              Apply
            </Button>
          </div>
        </div>
      </form>
    </Form>
  )
}
