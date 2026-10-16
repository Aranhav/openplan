import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, X } from "lucide-react"
import { type KeyboardEvent, type Ref, useEffect } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { useCreateItems } from "@/features/structure/api"
import { reportFormError } from "@/lib/form-errors"
import { structureNameSchema } from "@/lib/validation"
import { ParentPicker } from "./parent-picker"
import type { ItemDto } from "./types"

const baseSchema = z.object({
  name: structureNameSchema,
  code: z.string().trim(),
  parent: z.string(),
})

type NewItemValues = z.infer<typeof baseSchema>

interface NewItemRowProps {
  modelId: string
  listId: string
  /** The items of the parent list when the list has one; each new item then needs one of them. */
  parents?: ItemDto[]
  parentList?: string
  /** Gets the name input, for a button elsewhere to put focus in it. */
  nameRef?: Ref<HTMLInputElement>
  /** Called when the user stops adding items. */
  onClose: () => void
}

/**
 * The row at the top of the table that new items are typed into, under the column of checkboxes. Enter adds the item and leaves the
 * row ready for the next one, with the same parent; Escape or Cancel stops.
 */
export function NewItemRow({
  modelId,
  listId,
  parents,
  parentList,
  nameRef,
  onClose,
}: NewItemRowProps) {
  const createItems = useCreateItems(modelId)
  const needsParent = parents !== undefined
  const form = useForm<NewItemValues>({
    resolver: zodResolver(
      needsParent
        ? baseSchema.refine((values) => values.parent !== "", {
            path: ["parent"],
            message: "Choose a parent.",
          })
        : baseSchema,
    ),
    defaultValues: { name: "", code: "", parent: "" },
  })

  useEffect(() => {
    form.setFocus("name")
  }, [form])

  const add = form.handleSubmit(async (values) => {
    try {
      await createItems.mutateAsync({
        listId,
        items: [
          {
            name: values.name,
            ...(values.code !== "" && { code: values.code }),
            ...(needsParent && { parent_id: values.parent }),
          },
        ],
      })
      // One toast whose text changes, however many items are added in a row.
      toast.success(`Added ${values.name}`, { id: "item-added" })
      form.reset({ name: "", code: "", parent: values.parent })
      form.setFocus("name")
    } catch (error) {
      reportFormError(form, error, { "structure.name_taken": "name" })
    }
  })

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation()
      onClose()
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault()
      void add()
    }
  }

  const actions = (
    <>
      <Button type="button" size="sm" disabled={createItems.isPending} onClick={() => void add()}>
        {createItems.isPending && <Loader2 className="animate-spin" />}
        Add
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Stop adding items"
        disabled={createItems.isPending}
        onClick={onClose}
      >
        <X />
      </Button>
    </>
  )

  return (
    <Form {...form}>
      <TableRow className="bg-muted/30 align-top hover:bg-muted/30" onKeyDown={onKeyDown}>
        <TableCell />
        <TableCell className={needsParent ? "pl-8" : undefined}>
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="gap-1">
                <FormControl>
                  <Input
                    {...field}
                    ref={(element) => {
                      field.ref(element)
                      if (typeof nameRef === "function") {
                        nameRef(element)
                      } else if (nameRef) {
                        nameRef.current = element
                      }
                    }}
                    aria-label="New item name"
                    placeholder="Item name"
                    autoComplete="off"
                    readOnly={createItems.isPending}
                    className="h-8"
                  />
                </FormControl>
                <FormMessage className="whitespace-normal" />
              </FormItem>
            )}
          />
        </TableCell>
        <TableCell className={needsParent ? undefined : "pr-4"}>
          <div className="flex items-start gap-1">
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem className="min-w-0 flex-1 gap-1">
                  <FormControl>
                    <Input
                      {...field}
                      aria-label="New item code"
                      placeholder="Code (optional)"
                      autoComplete="off"
                      readOnly={createItems.isPending}
                      className="h-8"
                    />
                  </FormControl>
                  <FormMessage className="whitespace-normal" />
                </FormItem>
              )}
            />
            {!needsParent && actions}
          </div>
        </TableCell>
        {needsParent && (
          <TableCell className="pr-4">
            <div className="flex items-start gap-1">
              <FormField
                control={form.control}
                name="parent"
                render={({ field }) => (
                  <FormItem className="min-w-0 flex-1 gap-1">
                    <FormControl>
                      <ParentPicker
                        ref={field.ref}
                        parents={parents}
                        parentList={parentList ?? "the parent list"}
                        selected={parents.find((parent) => parent.id === field.value)}
                        onChange={field.onChange}
                        label="Parent of the new item"
                        disabled={createItems.isPending}
                      />
                    </FormControl>
                    <FormMessage className="whitespace-normal" />
                  </FormItem>
                )}
              />
              {actions}
            </div>
          </TableCell>
        )}
      </TableRow>
    </Form>
  )
}
