import { type UseFormReturn, useWatch } from "react-hook-form"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { summaryMethodLabel } from "@/features/structure/labels"
import type { LineItemDto } from "@/features/structure/types"
import {
  type LineItemValues,
  SAME_AS_SUMMARY,
  type SummaryMethodName,
  summaryMethodsFor,
} from "./line-item-form"

type Prefix = "summary" | "time_summary"

interface LineItemSummaryFieldsProps {
  form: UseFormReturn<LineItemValues>
  /** The other number line items of the module, which a ratio takes its parts from. */
  ratioParts: LineItemDto[]
  /** Whether the module has a Time dimension, which the time summary is about. */
  hasTime: boolean
  disabled?: boolean
}

/** How the line item's cells roll up along a hierarchy, and along time. */
export function LineItemSummaryFields({
  form,
  ratioParts,
  hasTime,
  disabled,
}: LineItemSummaryFieldsProps) {
  return (
    <div className="flex flex-col gap-4">
      <SummaryChoice
        form={form}
        prefix="summary"
        ratioParts={ratioParts}
        label="Summary"
        description="How the cells roll up to a total of a list."
        disabled={disabled}
      />
      <SummaryChoice
        form={form}
        prefix="time_summary"
        ratioParts={ratioParts}
        label="Time summary"
        description={
          hasTime
            ? "How the cells roll up to a quarter, half year or year."
            : "This module has no Time dimension."
        }
        disabled={disabled || !hasTime}
      />
    </div>
  )
}

interface SummaryChoiceProps {
  form: UseFormReturn<LineItemValues>
  prefix: Prefix
  ratioParts: LineItemDto[]
  label: string
  description: string
  disabled?: boolean
}

function SummaryChoice({
  form,
  prefix,
  ratioParts,
  label,
  description,
  disabled,
}: SummaryChoiceProps) {
  const formatType = useWatch({ control: form.control, name: "format_type" })
  const method = useWatch({ control: form.control, name: `${prefix}_method` })
  // A method the line item already has stays on offer, so the select never shows nothing.
  const methods: string[] = summaryMethodsFor(formatType)
  const offered =
    method === SAME_AS_SUMMARY || methods.includes(method) ? methods : [...methods, method]

  return (
    <div className="flex flex-col gap-4">
      <FormField
        control={form.control}
        name={`${prefix}_method`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>{label}</FormLabel>
            <Select
              value={field.value}
              onValueChange={field.onChange}
              disabled={disabled || (prefix === "summary" && methods.length === 1)}
            >
              <FormControl>
                <SelectTrigger ref={field.ref} className="w-full">
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {prefix === "time_summary" && (
                  <SelectItem value={SAME_AS_SUMMARY}>Same as summary</SelectItem>
                )}
                {offered.map((name) => (
                  <SelectItem key={name} value={name}>
                    {summaryMethodLabel(name as SummaryMethodName)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription>
              {prefix === "summary" && methods.length === 1
                ? "Text, date, list and period values are blank in a total."
                : description}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      {method === "ratio" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <RatioPart
            form={form}
            name={`${prefix}_numerator`}
            label="Numerator"
            options={ratioParts}
            disabled={disabled}
          />
          <RatioPart
            form={form}
            name={`${prefix}_denominator`}
            label="Denominator"
            options={ratioParts}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  )
}

interface RatioPartProps {
  form: UseFormReturn<LineItemValues>
  name: `${Prefix}_numerator` | `${Prefix}_denominator`
  label: string
  options: LineItemDto[]
  disabled?: boolean
}

function RatioPart({ form, name, label, options, disabled }: RatioPartProps) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select
            value={field.value}
            onValueChange={field.onChange}
            disabled={disabled || options.length === 0}
          >
            <FormControl>
              <SelectTrigger ref={field.ref} className="w-full">
                <SelectValue
                  placeholder={options.length === 0 ? "No number line items" : "Choose a line item"}
                />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
