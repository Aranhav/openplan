import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useForm, useWatch } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { ProductionLock } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useUpdateCalendar } from "@/features/structure/api"
import type { StructureDto } from "@/features/structure/types"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import type { components } from "@/lib/api/schema"
import { reportFormError } from "@/lib/form-errors"
import { ChangeTimelineDialog } from "./change-timeline-dialog"
import { draftTimeline, fiscalYearLabel } from "./timeline"
import { TimelinePreviewCard } from "./timeline-preview"
import { wholeNumberIn, wholeNumberSchema } from "./whole-number"

type CalendarDto = components["schemas"]["CalendarDto"]

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** What the current period's select holds for no period; a month label never looks like this. */
const NO_PERIOD = "none"

const schema = z.object({
  fiscal_year_start_month: z.string(),
  first_year: wholeNumberSchema("First fiscal year", 1, 9999),
  years: wholeNumberSchema("Years", 1, 20),
  current_period: z.string(),
})

type CalendarValues = z.infer<typeof schema>

const FIELDS = ["fiscal_year_start_month", "first_year", "years", "current_period"] as const

function valuesOf(calendar: CalendarDto): CalendarValues {
  return {
    fiscal_year_start_month: String(calendar.fiscal_year_start_month),
    first_year: String(calendar.first_year),
    years: String(calendar.years),
    current_period: calendar.current_period ?? "",
  }
}

/** The calendar the structure holds, worded the way the calendar endpoint takes it. */
function savedCalendar({ calendar, month_labels }: StructureDto): CalendarDto {
  return {
    fiscal_year_start_month: calendar.fiscal_year_start_month,
    first_year: calendar.first_year,
    years: calendar.years,
    current_period: calendar.current_month == null ? null : month_labels[calendar.current_month],
  }
}

function requestOf(values: CalendarValues): CalendarDto {
  return {
    fiscal_year_start_month: Number(values.fiscal_year_start_month),
    first_year: Number(values.first_year),
    years: Number(values.years),
    current_period: values.current_period || null,
  }
}

/** A different start month or length moves every period; a different first year only renames them. */
function changesTimeline(values: CalendarValues, saved: CalendarValues) {
  return (
    values.fiscal_year_start_month !== saved.fiscal_year_start_month ||
    Number(values.years) !== Number(saved.years)
  )
}

interface CalendarSectionProps {
  modelId: string
  structure: StructureDto
  /** Whether the signed-in user may change the calendar; if not, it is shown as text. */
  canEdit: boolean
  /** Whether production mode switches the form off. */
  locked: boolean
}

/** The calendar and the preview of its timeline, which follows the form while it is edited. */
export function CalendarSection({ modelId, structure, canEdit, locked }: CalendarSectionProps) {
  if (!canEdit) {
    return (
      <>
        <CalendarCard description="Only workspace admins and builders can change the calendar.">
          <CalendarDetails structure={structure} />
        </CalendarCard>
        <TimelinePreviewCard timeline={structure.calendar} unsaved={false} />
      </>
    )
  }
  return <CalendarForm modelId={modelId} structure={structure} locked={locked} />
}

function CalendarCard({ description, children }: { description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Calendar
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children}
    </Card>
  )
}

interface CalendarFormProps {
  modelId: string
  structure: StructureDto
  locked: boolean
}

function CalendarForm({ modelId, structure, locked }: CalendarFormProps) {
  const updateCalendar = useUpdateCalendar(modelId)
  const saved = valuesOf(savedCalendar(structure))
  // The form follows the structure: a field nobody has touched takes the latest saved value (a
  // change from elsewhere shows up), a field being edited keeps what was typed.
  const form = useForm<CalendarValues>({
    resolver: zodResolver(schema),
    values: saved,
    resetOptions: { keepDirtyValues: true },
  })
  // The values waiting for a yes to the change of timeline.
  const [confirming, setConfirming] = useState<CalendarValues>()
  const { ref: saveRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const [startMonth, firstYearText, yearsText] = useWatch({
    control: form.control,
    name: ["fiscal_year_start_month", "first_year", "years"],
  })
  const firstYear = wholeNumberIn(firstYearText, 1, 9999)
  const firstYearLabel = firstYear === undefined ? undefined : fiscalYearLabel(firstYear)
  // What the timeline will be once the form is saved, as far as the fields are valid.
  const draft = draftTimeline(
    { fiscal_year_start_month: startMonth, first_year: firstYearText, years: yearsText },
    structure.calendar,
  )
  const unsaved =
    draft.fiscal_year_start_month !== structure.calendar.fiscal_year_start_month ||
    draft.first_year !== structure.calendar.first_year ||
    draft.years !== structure.calendar.years

  async function save(values: CalendarValues) {
    try {
      const calendar = await updateCalendar.mutateAsync(requestOf(values))
      // Starts over from what the server kept, so the form is clean again; without the option,
      // the form's own `keepDirtyValues` would keep what was typed.
      form.reset(valuesOf(calendar), { keepDirtyValues: false })
      toast.success("Calendar saved")
    } catch (error) {
      reportFormError(form, error)
    }
  }

  async function onSubmit(values: CalendarValues) {
    if (changesTimeline(values, saved)) {
      setConfirming(values)
    } else {
      await save(values)
    }
  }

  async function confirm() {
    if (confirming) {
      await save(confirming)
      setConfirming(undefined)
    }
  }

  // Back to the save button, or if the server refused a field to that field, which is on screen
  // again once the dialog is gone.
  function afterDialog(event: Event) {
    const refused = FIELDS.find((name) => form.getFieldState(name).error)
    if (refused) {
      event.preventDefault()
      form.setFocus(refused)
    } else {
      restoreFocus(event)
    }
  }

  return (
    <Form {...form}>
      <CalendarCard description="When the fiscal year starts and how many fiscal years the model covers.">
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
          <CardContent className="grid gap-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="fiscal_year_start_month"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fiscal year starts</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange} disabled={locked}>
                    <FormControl>
                      <SelectTrigger ref={field.ref} onBlur={field.onBlur} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {MONTH_NAMES.map((name, index) => (
                        <SelectItem key={name} value={String(index + 1)}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>The month each fiscal year begins in.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="first_year"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>First fiscal year</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={9999}
                      disabled={locked}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {`The year the first fiscal year ends in.${firstYearLabel ? ` Shown as ${firstYearLabel}.` : ""}`}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="years"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Years</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={20}
                      disabled={locked}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    How many fiscal years the model covers, up to 20.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="current_period"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Current period</FormLabel>
                  <Select
                    value={field.value || NO_PERIOD}
                    onValueChange={(value) => field.onChange(value === NO_PERIOD ? "" : value)}
                    disabled={locked}
                  >
                    <FormControl>
                      <SelectTrigger ref={field.ref} onBlur={field.onBlur} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NO_PERIOD}>None</SelectItem>
                      {structure.month_labels.map((label) => (
                        <SelectItem key={label} value={label}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>The month the model is in now. Optional.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
          <CardFooter className="justify-end">
            <ProductionLock locked={locked}>
              <Button
                ref={saveRef}
                type="submit"
                disabled={locked || !form.formState.isDirty || updateCalendar.isPending}
              >
                {updateCalendar.isPending && <Loader2 className="animate-spin" />}
                Save changes
              </Button>
            </ProductionLock>
          </CardFooter>
        </form>
      </CalendarCard>
      <TimelinePreviewCard timeline={draft} unsaved={unsaved} />
      <ChangeTimelineDialog
        open={confirming !== undefined}
        pending={updateCalendar.isPending}
        onConfirm={() => void confirm()}
        onOpenChange={(open) => !open && setConfirming(undefined)}
        onCloseAutoFocus={afterDialog}
      />
    </Form>
  )
}

function CalendarDetails({ structure }: { structure: StructureDto }) {
  const { calendar } = structure
  const currentPeriod = savedCalendar(structure).current_period
  return (
    <CardContent>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <Detail label="Fiscal year starts">
          {MONTH_NAMES[calendar.fiscal_year_start_month - 1]}
        </Detail>
        <Detail label="First fiscal year">
          {`${fiscalYearLabel(calendar.first_year)} (${calendar.first_year})`}
        </Detail>
        <Detail label="Years">{calendar.years}</Detail>
        <Detail label="Current period">
          {currentPeriod ?? <span className="text-muted-foreground">None</span>}
        </Detail>
      </dl>
    </CardContent>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
