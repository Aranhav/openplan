import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useForm, useWatch } from "react-hook-form"
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
import { timeLevelLabel } from "@/features/structure/labels"
import { useCreateLineItem, useReorderLineItems } from "@/features/structure/api"
import type { LineItemDto, StructureDto } from "@/features/structure/types"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import { NAME_TAKEN_FIELD_ERRORS, reportFormError } from "@/lib/form-errors"
import { structureNameSchema } from "@/lib/validation"
import { MODULE_TIME_LEVELS } from "./axes"
import {
  FORMAT_TYPES,
  FORMAT_TYPE_LABELS,
  type FormatType,
  PLAIN_NUMBER,
  defaultSummaryFor,
  formatOf,
} from "./line-item-form"

const schema = z
  .object({
    name: structureNameSchema,
    format_type: z.enum(FORMAT_TYPES),
    list: z.string(),
    period_level: z.enum(MODULE_TIME_LEVELS),
  })
  .refine((values) => values.format_type !== "list" || values.list !== "", {
    path: ["list"],
    message: "Choose a list.",
  })

type AddLineItemValues = z.infer<typeof schema>

interface AddLineItemDialogProps {
  modelId: string
  /** The module the line item goes in; for the properties of a list, the id of the list. */
  moduleId: string
  structure: StructureDto
  /** The line items of the module now, in order. */
  lineItems: LineItemDto[]
  /** The line item to put the new one below; the new one goes last without it. */
  insertAfter?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new line item once it is where it goes. */
  onAdded?: (lineItem: LineItemDto) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function AddLineItemDialog({
  modelId,
  moduleId,
  structure,
  lineItems,
  insertAfter,
  open,
  onOpenChange,
  onAdded,
  onCloseAutoFocus,
}: AddLineItemDialogProps) {
  const createLineItem = useCreateLineItem(modelId)
  const reorder = useReorderLineItems(modelId)
  const pending = createLineItem.isPending || reorder.isPending
  const below = lineItems.find((item) => item.id === insertAfter)

  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy(pending, onOpenChange)}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Add line item</DialogTitle>
          <DialogDescription>
            {below
              ? `Name it and choose what it holds. It goes below ${below.name}.`
              : "Name it and choose what it holds. It goes at the end."}
          </DialogDescription>
        </DialogHeader>
        <AddLineItemForm
          structure={structure}
          pending={pending}
          onAdd={async (values) => {
            const created = await createLineItem.mutateAsync({
              moduleId,
              body: {
                name: values.name,
                format: formatOf({ ...PLAIN_NUMBER, ...values }),
                summary: { method: defaultSummaryFor(values.format_type) },
              },
            })
            const at = lineItems.findIndex((item) => item.id === insertAfter)
            // Created last; a line item below another needs the order set.
            if (at >= 0 && at < lineItems.length - 1) {
              const ids = lineItems.map((item) => item.id)
              ids.splice(at + 1, 0, created.id)
              try {
                await reorder.mutateAsync({ module_id: moduleId, ids })
              } catch {
                toast.error(
                  `The line item was added at the end; moving it below ${below?.name} failed.`,
                )
              }
            }
            return created
          }}
          onAdded={(lineItem) => {
            toast.success("Line item added")
            onOpenChange(false)
            onAdded?.(lineItem)
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

interface AddLineItemFormProps {
  structure: StructureDto
  pending: boolean
  onAdd: (values: AddLineItemValues) => Promise<LineItemDto>
  onAdded: (lineItem: LineItemDto) => void
  onCancel: () => void
}

// A separate component, so the form starts empty each time the dialog opens.
function AddLineItemForm({ structure, pending, onAdd, onAdded, onCancel }: AddLineItemFormProps) {
  const form = useForm<AddLineItemValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", format_type: "number", list: "", period_level: "month" },
  })
  const formatType = useWatch({ control: form.control, name: "format_type" })

  async function onSubmit(values: AddLineItemValues) {
    try {
      onAdded(await onAdd(values))
    } catch (error) {
      reportFormError(form, error, NAME_TAKEN_FIELD_ERRORS)
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
                <Input placeholder="Unit price" autoComplete="off" autoFocus {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="format_type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Format type</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger ref={field.ref} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {FORMAT_TYPES.map((type: FormatType) => (
                    <SelectItem key={type} value={type}>
                      {FORMAT_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                You can change the format and set its options later.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
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
                  disabled={structure.lists.length === 0}
                >
                  <FormControl>
                    <SelectTrigger ref={field.ref} className="w-full">
                      <SelectValue
                        placeholder={
                          structure.lists.length === 0 ? "No lists yet" : "Choose a list"
                        }
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
                <Select value={field.value} onValueChange={field.onChange}>
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
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            Add line item
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
