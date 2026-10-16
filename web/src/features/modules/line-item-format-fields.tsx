import { type UseFormReturn, useWatch } from "react-hook-form"
import { formatValue } from "@/features/grid/core/format-value"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { timeLevelLabel } from "@/features/structure/labels"
import type { StructureDto } from "@/features/structure/types"
import { wholeNumberIn } from "@/features/time/whole-number"
import { MODULE_TIME_LEVELS } from "./axes"
import {
  FORMAT_TYPES,
  FORMAT_TYPE_LABELS,
  type FormatType,
  type LineItemValues,
  SAME_AS_SUMMARY,
  defaultSummaryFor,
  formatOf,
  summaryMethodsFor,
} from "./line-item-form"

const UNIT_LABELS = { none: "None", currency: "Currency", percent: "Percent" } as const

interface LineItemFormatFieldsProps {
  form: UseFormReturn<LineItemValues>
  structure: StructureDto
  disabled?: boolean
}

/** The format of a line item: what kind of value it holds and, for each kind, how it is shown. */
export function LineItemFormatFields({ form, structure, disabled }: LineItemFormatFieldsProps) {
  const formatType = useWatch({ control: form.control, name: "format_type" })
  const unit = useWatch({ control: form.control, name: "unit" })

  // A new kind of value may not be summarized the way the old one was.
  function chooseFormat(next: FormatType) {
    form.setValue("format_type", next, { shouldDirty: true })
    for (const field of ["summary_method", "time_summary_method"] as const) {
      const current = form.getValues(field)
      if (current !== SAME_AS_SUMMARY && !(summaryMethodsFor(next) as string[]).includes(current)) {
        form.setValue(
          field,
          field === "summary_method" ? defaultSummaryFor(next) : SAME_AS_SUMMARY,
          { shouldDirty: true },
        )
      }
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <FormField
        control={form.control}
        name="format_type"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Format type</FormLabel>
            <Select
              value={field.value}
              onValueChange={(value) => chooseFormat(value as FormatType)}
              disabled={disabled}
            >
              <FormControl>
                <SelectTrigger ref={field.ref} className="w-full">
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {FORMAT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {FORMAT_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
      {formatType === "number" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="decimals"
              render={({ field }) => (
                <FormItem className="content-start">
                  <FormLabel>Decimals</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={10}
                      disabled={disabled}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>From 0 to 10.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="unit"
              render={({ field }) => (
                <FormItem className="content-start">
                  <FormLabel>Unit</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
                    <FormControl>
                      <SelectTrigger ref={field.ref} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {Object.entries(UNIT_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          {unit === "currency" && (
            <FormField
              control={form.control}
              name="currency_code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Currency code</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="USD"
                      maxLength={3}
                      autoComplete="off"
                      disabled={disabled}
                      className="uppercase"
                      {...field}
                      onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                    />
                  </FormControl>
                  <FormDescription>
                    The three letters of an ISO 4217 code, such as EUR.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
          <FormField
            control={form.control}
            name="thousands_sep"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between gap-4 rounded-md border p-3">
                <FormLabel>Thousands separator</FormLabel>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={disabled}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="negative"
            render={({ field }) => (
              <FormItem>
                <FormLabel id="negative-label">Negative numbers</FormLabel>
                <FormControl>
                  <RadioGroup
                    aria-labelledby="negative-label"
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={disabled}
                    className="grid-cols-2"
                  >
                    {(
                      [
                        ["minus", "Minus sign"],
                        ["parens", "Parentheses"],
                      ] as const
                    ).map(([value, label]) => (
                      <div key={value} className="flex items-center gap-2">
                        <RadioGroupItem value={value} id={`negative-${value}`} />
                        <Label htmlFor={`negative-${value}`} className="font-normal">
                          {label}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <NumberPreview form={form} />
        </>
      )}
      {formatType === "list" && (
        <FormField
          control={form.control}
          name="list"
          render={({ field }) => (
            <FormItem>
              <FormLabel>List</FormLabel>
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={disabled || structure.lists.length === 0}
              >
                <FormControl>
                  <SelectTrigger ref={field.ref} className="w-full">
                    <SelectValue
                      placeholder={structure.lists.length === 0 ? "No lists yet" : "Choose a list"}
                    />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {structure.lists.map((list) => (
                    <SelectItem key={list.id} value={list.id}>
                      {list.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>Each cell holds one item of this list.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
      {formatType === "time_period" && (
        <FormField
          control={form.control}
          name="period_level"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Period level</FormLabel>
              <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
                <FormControl>
                  <SelectTrigger ref={field.ref} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {MODULE_TIME_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {timeLevelLabel(level)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>Each cell holds one period of this level.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </div>
  )
}

/** A number to show as an example: a percentage is stored as a fraction. */
function exampleFor(unit: string) {
  return unit === "percent" ? 0.12345 : 1234.5678
}

/** How the options chosen so far write a positive and a negative number. */
function NumberPreview({ form }: { form: UseFormReturn<LineItemValues> }) {
  const values = useWatch({ control: form.control })
  const decimals = wholeNumberIn(values.decimals ?? "", 0, 10)
  if (decimals === undefined) {
    return null
  }
  const format = formatOf({ ...(values as LineItemValues), decimals: String(decimals) })
  const example = exampleFor(values.unit ?? "none")
  return (
    <p className="text-sm text-muted-foreground">
      Shown as{" "}
      <span className="font-mono text-foreground tabular-nums">
        {formatValue({ t: "number", v: example }, format)}
      </span>{" "}
      and{" "}
      <span className="font-mono text-foreground tabular-nums">
        {formatValue({ t: "number", v: -example }, format)}
      </span>
      .
    </p>
  )
}
