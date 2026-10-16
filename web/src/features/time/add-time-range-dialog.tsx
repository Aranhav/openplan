import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { useCreateTimeRange } from "@/features/structure/api"
import type { StructureDto } from "@/features/structure/types"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import { reportFormError } from "@/lib/form-errors"
import { structureNameSchema } from "@/lib/validation"
import { wholeNumberSchema } from "./whole-number"

const schema = z.object({
  name: structureNameSchema,
  first_year: wholeNumberSchema("First year", 1, 9999),
  years: wholeNumberSchema("Years", 1, 20),
})

type TimeRangeValues = z.infer<typeof schema>

/** Where a refusal that carries only a code belongs: a name that is taken is about the name. */
const FIELD_ERRORS = { "structure.name_taken": "name" } as const

interface AddTimeRangeDialogProps {
  modelId: string
  /** The range starts out as the whole calendar. */
  calendar: StructureDto["calendar"]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function AddTimeRangeDialog({
  modelId,
  calendar,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: AddTimeRangeDialogProps) {
  const createTimeRange = useCreateTimeRange(modelId)
  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy(createTimeRange.isPending, onOpenChange)}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={!createTimeRange.isPending}
      >
        <DialogHeader>
          <DialogTitle>Add time range</DialogTitle>
          <DialogDescription>Name it and choose the fiscal years it covers.</DialogDescription>
        </DialogHeader>
        <AddTimeRangeForm
          createTimeRange={createTimeRange}
          calendar={calendar}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

interface AddTimeRangeFormProps {
  createTimeRange: ReturnType<typeof useCreateTimeRange>
  calendar: StructureDto["calendar"]
  onClose: () => void
}

// A separate component, so the form starts afresh each time the dialog opens.
function AddTimeRangeForm({ createTimeRange, calendar, onClose }: AddTimeRangeFormProps) {
  const form = useForm<TimeRangeValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      first_year: String(calendar.first_year),
      years: String(calendar.years),
    },
  })

  async function onSubmit({ name, first_year, years }: TimeRangeValues) {
    try {
      await createTimeRange.mutateAsync({
        name,
        first_year: Number(first_year),
        years: Number(years),
      })
      toast.success("Time range added")
      onClose()
    } catch (error) {
      reportFormError(form, error, FIELD_ERRORS)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Forecast years" autoComplete="off" autoFocus {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="first_year"
            render={({ field }) => (
              <FormItem>
                <FormLabel>First year</FormLabel>
                <FormControl>
                  <Input type="number" inputMode="numeric" min={1} max={9999} {...field} />
                </FormControl>
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
                  <Input type="number" inputMode="numeric" min={1} max={20} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={createTimeRange.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createTimeRange.isPending}>
            {createTimeRange.isPending && <Loader2 className="animate-spin" />}
            Add time range
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
