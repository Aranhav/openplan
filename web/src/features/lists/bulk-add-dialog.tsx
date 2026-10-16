import { zodResolver } from "@hookform/resolvers/zod"
import { CircleAlert, Loader2 } from "lucide-react"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Textarea } from "@/components/ui/textarea"
import { useCreateItems } from "@/features/structure/api"
import { ApiError, errorDetail } from "@/lib/api/client"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import { type BulkLineError, countLines, parseBulkAdd } from "./bulk-add"
import type { ItemDto, ListDto } from "./types"
import { countOf } from "@/lib/format"

const schema = z.object({
  lines: z.string().refine((text) => text.trim() !== "", "Enter at least one item."),
})

type BulkValues = z.infer<typeof schema>

/** The most problems listed; a pasted block can have a thousand. */
const MAX_LISTED = 10

interface BulkAddDialogProps {
  modelId: string
  list: ListDto
  /** The items the list has already. */
  existing: ItemDto[]
  /** The items of the parent list when the list has one. */
  parents?: ItemDto[]
  parentList?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function BulkAddDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  ...rest
}: BulkAddDialogProps) {
  const createItems = useCreateItems(rest.modelId)
  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy(createItems.isPending, onOpenChange)}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={!createItems.isPending}
        className="max-h-[calc(100svh-2rem)] gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Bulk add items</DialogTitle>
          <DialogDescription>
            {rest.parents
              ? `Type or paste one item on each line, as “Name, Parent”. The parent is an item of ${rest.parentList ?? "the parent list"}, by its name or its code.`
              : "Type or paste one item on each line."}{" "}
            If any line has a problem, none of the items are added.
          </DialogDescription>
        </DialogHeader>
        <BulkAddForm {...rest} createItems={createItems} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

interface BulkAddFormProps extends Omit<
  BulkAddDialogProps,
  "open" | "onOpenChange" | "onCloseAutoFocus"
> {
  createItems: ReturnType<typeof useCreateItems>
  onClose: () => void
}

// A separate component, so the form starts empty each time the dialog opens.
function BulkAddForm({
  list,
  existing,
  parents,
  parentList,
  createItems,
  onClose,
}: BulkAddFormProps) {
  const form = useForm<BulkValues>({ resolver: zodResolver(schema), defaultValues: { lines: "" } })
  // What is wrong with the lines, line by line; the form's own message sums it up.
  const [problems, setProblems] = useState<BulkLineError[]>([])

  async function onSubmit({ lines }: BulkValues) {
    const parsed = parseBulkAdd(lines, { existing, numbered: list.numbered, parents, parentList })
    if (parsed.errors.length > 0) {
      setProblems(parsed.errors)
      form.setError(
        "lines",
        { message: "Nothing was added. Fix these lines and try again." },
        { shouldFocus: true },
      )
      return
    }
    try {
      await createItems.mutateAsync({ listId: list.id, items: parsed.items })
      toast.success(`Added ${countOf(parsed.items.length, "item")}`)
      onClose()
    } catch (error) {
      setProblems(serverProblems(error, parsed.lines))
      form.setError("lines", { message: "Nothing was added." }, { shouldFocus: true })
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        noValidate
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
          <FormField
            control={form.control}
            name="lines"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Items</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    rows={8}
                    spellCheck={false}
                    autoFocus
                    placeholder={parents ? "Paris, France\nLyon, France" : "Widgets\nGadgets"}
                    className="font-mono"
                    onChange={(event) => {
                      field.onChange(event)
                      setProblems([])
                    }}
                  />
                </FormControl>
                <FormDescription>{countOf(countLines(field.value), "line")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          {problems.length > 0 && <Problems problems={problems} />}
        </div>
        <DialogFooter className="border-t p-4 sm:px-6">
          <Button
            type="button"
            variant="outline"
            disabled={createItems.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createItems.isPending}>
            {createItems.isPending && <Loader2 className="animate-spin" />}
            Add items
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}

function Problems({ problems }: { problems: BulkLineError[] }) {
  const listed = problems.slice(0, MAX_LISTED)
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{countOf(problems.length, "problem")}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {listed.map((problem, index) => (
            <li key={index}>
              {problem.line > 0 ? `Line ${problem.line}: ` : ""}
              {problem.message}
            </li>
          ))}
        </ul>
        {problems.length > listed.length && (
          <p>And {countOf(problems.length - listed.length, "more problem")}.</p>
        )}
      </AlertDescription>
    </Alert>
  )
}

/** The server's refusal as lines: its `items[3].name` becomes the fourth item's line, the rest a line of no number. */
function serverProblems(error: unknown, lines: number[]): BulkLineError[] {
  if (error instanceof ApiError) {
    const located = error.errors.flatMap(({ field, message }) => {
      const index = /^items\[(\d+)\]/.exec(field)?.[1]
      const line = index === undefined ? undefined : lines[Number(index)]
      return line === undefined ? [] : [{ line, message }]
    })
    if (located.length > 0) {
      return located
    }
  }
  return [{ line: 0, message: errorDetail(error) }]
}
