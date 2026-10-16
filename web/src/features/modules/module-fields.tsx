import type { UseFormReturn } from "react-hook-form"
import { Button } from "@/components/ui/button"
import {
  FormControl,
  FormDescription,
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
import { Switch } from "@/components/ui/switch"
import { timeLevelLabel } from "@/features/structure/labels"
import type { StructureDto } from "@/features/structure/types"
import { MODULE_TIME_LEVELS, WHOLE_CALENDAR, dimensionOptions } from "./axes"
import { DimensionPicker } from "./dimension-picker"
import type { ModuleValues } from "./module-form"

/** The most existing functional areas offered as shortcuts; more would crowd the form. */
const MAX_AREA_SHORTCUTS = 8

/** What the time range's select holds for the whole calendar; a range's id never looks like this. */
const CALENDAR_VALUE = "calendar"

interface ModuleFieldsProps {
  form: UseFormReturn<ModuleValues>
  structure: StructureDto
  /** The functional areas the model's modules are in already, offered as shortcuts. */
  areas: string[]
  disabled?: boolean
}

/** The name, functional area and dimensions of a module, which both the new module form and its settings ask for. */
export function ModuleFields({ form, structure, areas, disabled }: ModuleFieldsProps) {
  const time = form.watch("time")
  const hasRanges = structure.time_ranges.length > 0

  return (
    <>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl>
              <Input placeholder="Revenue" autoComplete="off" disabled={disabled} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="functional_area"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Functional area</FormLabel>
            <FormControl>
              <Input placeholder="Finance" autoComplete="off" disabled={disabled} {...field} />
            </FormControl>
            <FormDescription>
              Optional. Modules in the same area are listed together.
            </FormDescription>
            {areas.length > 0 && !disabled && (
              <div
                role="group"
                aria-label="Existing functional areas"
                className="flex flex-wrap gap-1.5"
              >
                {areas.slice(0, MAX_AREA_SHORTCUTS).map((area) => (
                  <Button
                    key={area}
                    type="button"
                    variant="outline"
                    size="xs"
                    aria-pressed={field.value.trim() === area}
                    className="aria-pressed:border-primary aria-pressed:bg-accent"
                    onClick={() => form.setValue("functional_area", area, { shouldDirty: true })}
                  >
                    {area}
                  </Button>
                ))}
              </div>
            )}
            <FormMessage />
          </FormItem>
        )}
      />
      <fieldset className="flex min-w-0 flex-col gap-4" disabled={disabled}>
        <legend className="mb-3 text-sm leading-none font-medium">Dimensions</legend>
        <FormField
          control={form.control}
          name="dimensions"
          render={({ field }) => (
            <FormItem>
              <FormDescription>
                The lists and subsets the line items are laid out over. Tick the ones to use, then
                put them in order.
              </FormDescription>
              <DimensionPicker
                options={dimensionOptions(structure)}
                value={field.value}
                onChange={field.onChange}
                disabled={disabled}
                label="Lists and subsets"
                emptyMessage="This model has no lists yet. Without any, each line item has a single value for each period."
              />
              <FormMessage role="alert" />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="time"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between gap-4 rounded-md border p-3">
              <div className="flex flex-col gap-1">
                <FormLabel>Time</FormLabel>
                <FormDescription>One column for each period of the calendar.</FormDescription>
              </div>
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
        {time && (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="time_level"
              render={({ field }) => (
                <FormItem className="content-start">
                  <FormLabel>Time level</FormLabel>
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
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="time_range"
              render={({ field }) => (
                <FormItem className="content-start">
                  <FormLabel>Time range</FormLabel>
                  <Select
                    value={field.value === WHOLE_CALENDAR ? CALENDAR_VALUE : field.value}
                    onValueChange={(value) =>
                      field.onChange(value === CALENDAR_VALUE ? WHOLE_CALENDAR : value)
                    }
                    disabled={disabled || !hasRanges}
                  >
                    <FormControl>
                      <SelectTrigger ref={field.ref} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={CALENDAR_VALUE}>Whole calendar</SelectItem>
                      {structure.time_ranges.map((range) => (
                        <SelectItem key={range.id} value={range.id}>
                          {range.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!hasRanges && (
                    <FormDescription>Time ranges are added on the Time screen.</FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        )}
        <FormField
          control={form.control}
          name="versions"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between gap-4 rounded-md border p-3">
              <div className="flex flex-col gap-1">
                <FormLabel>Versions</FormLabel>
                <FormDescription>One set of values for each version.</FormDescription>
              </div>
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
      </fieldset>
    </>
  )
}
