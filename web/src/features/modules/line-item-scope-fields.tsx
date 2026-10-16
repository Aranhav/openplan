import { type UseFormReturn, useWatch } from "react-hook-form"
import { Checkbox } from "@/components/ui/checkbox"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { dimsLabel, timeLevelLabel } from "@/features/structure/labels"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import { dimensionOptions } from "./axes"
import { DimensionPicker } from "./dimension-picker"
import {
  APPLIES_TO_CHOSEN,
  APPLIES_TO_MODULE,
  type LineItemValues,
  TIME_SCALE_MODULE,
  TIME_SCALE_NONE,
  VERSIONS_CHOSEN,
  VERSIONS_MODULE,
  VERSIONS_NONE,
  timeScaleLevels,
} from "./line-item-form"

interface LineItemScopeFieldsProps {
  form: UseFormReturn<LineItemValues>
  module: ModuleDto
  structure: StructureDto
  disabled?: boolean
}

/** Which of the module's dimensions the line item has: its lists, its time scale and its versions. */
export function LineItemScopeFields({
  form,
  module,
  structure,
  disabled,
}: LineItemScopeFieldsProps) {
  const moduleTime = module.axes.find((axis) => axis.kind === "time")
  const hasVersions = module.axes.some((axis) => axis.kind === "versions")
  const appliesMode = useWatch({ control: form.control, name: "applies_mode" })
  const versionsMode = useWatch({ control: form.control, name: "versions_mode" })
  const ownAxes = module.axes.filter((axis) => axis.kind === "list" || axis.kind === "subset")

  return (
    <div className="flex flex-col gap-4">
      <FormField
        control={form.control}
        name="applies_mode"
        render={({ field }) => (
          <FormItem>
            <FormLabel id="applies-to-label">Applies to</FormLabel>
            <FormControl>
              <RadioGroup
                aria-labelledby="applies-to-label"
                value={field.value}
                onValueChange={field.onChange}
                disabled={disabled}
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem
                    value={APPLIES_TO_MODULE}
                    id="applies-to-module"
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor="applies-to-module"
                    className="flex-col items-start gap-0.5 font-normal"
                  >
                    Module default
                    <span className="text-sm text-muted-foreground">
                      {ownAxes.length === 0
                        ? "The module has no lists, so the line item has a single value."
                        : dimsLabel(ownAxes, structure)}
                    </span>
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem
                    value={APPLIES_TO_CHOSEN}
                    id="applies-to-chosen"
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor="applies-to-chosen"
                    className="flex-col items-start gap-0.5 font-normal"
                  >
                    Chosen lists and subsets
                    <span className="text-sm text-muted-foreground">
                      Replaces the module's lists for this line item.
                    </span>
                  </Label>
                </div>
              </RadioGroup>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      {appliesMode === APPLIES_TO_CHOSEN && (
        <FormField
          control={form.control}
          name="applies_to"
          render={({ field }) => (
            <FormItem>
              <DimensionPicker
                options={dimensionOptions(structure)}
                value={field.value}
                onChange={field.onChange}
                disabled={disabled}
                label="Lists and subsets the line item applies to"
                emptyMessage="This model has no lists yet."
              />
              <FormMessage />
            </FormItem>
          )}
        />
      )}
      <FormField
        control={form.control}
        name="time_scale"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Time scale</FormLabel>
            <Select
              value={field.value}
              onValueChange={field.onChange}
              disabled={disabled || !moduleTime}
            >
              <FormControl>
                <SelectTrigger ref={field.ref} className="w-full">
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value={TIME_SCALE_MODULE}>Module default</SelectItem>
                <SelectItem value={TIME_SCALE_NONE}>None</SelectItem>
                {timeScaleLevels(moduleTime?.level).map((level) => (
                  <SelectItem key={level} value={`level:${level}`}>
                    {timeLevelLabel(level)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription>
              {moduleTime
                ? "The periods the line item has a value for: the module's or coarser ones."
                : "This module has no Time dimension."}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="versions_mode"
        render={({ field }) => (
          <FormItem>
            <FormLabel id="versions-label">Versions</FormLabel>
            <FormControl>
              <RadioGroup
                aria-labelledby="versions-label"
                value={field.value}
                onValueChange={field.onChange}
                disabled={disabled || !hasVersions}
                className="grid-cols-1 sm:grid-cols-3"
              >
                {(
                  [
                    [VERSIONS_MODULE, "Module default"],
                    [VERSIONS_NONE, "None"],
                    [VERSIONS_CHOSEN, "Chosen versions"],
                  ] as const
                ).map(([value, label]) => (
                  <div key={value} className="flex items-center gap-2">
                    <RadioGroupItem value={value} id={`versions-${value}`} />
                    <Label htmlFor={`versions-${value}`} className="font-normal">
                      {label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </FormControl>
            {!hasVersions && (
              <FormDescription>This module has no Versions dimension.</FormDescription>
            )}
            <FormMessage />
          </FormItem>
        )}
      />
      {versionsMode === VERSIONS_CHOSEN && hasVersions && (
        <FormField
          control={form.control}
          name="versions_only"
          render={({ field }) => (
            <FormItem>
              <div
                role="group"
                aria-label="Versions the line item has values for"
                className="flex flex-col gap-1 rounded-md border p-1"
              >
                {structure.versions.map((version) => {
                  const id = `versions-only-${version.id}`
                  return (
                    <div
                      key={version.id}
                      className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-muted/50"
                    >
                      <Checkbox
                        id={id}
                        checked={field.value.includes(version.id)}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          field.onChange(
                            structure.versions
                              .map((candidate) => candidate.id)
                              .filter((candidate) =>
                                candidate === version.id
                                  ? checked === true
                                  : field.value.includes(candidate),
                              ),
                          )
                        }
                      />
                      <Label htmlFor={id} className="flex-1 cursor-pointer font-normal">
                        {version.name}
                      </Label>
                    </div>
                  )
                })}
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </div>
  )
}
