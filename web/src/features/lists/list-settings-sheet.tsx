import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, Trash2 } from "lucide-react"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { DeleteDialog } from "@/components/delete-dialog"
import { ProductionLock, ProductionNotice } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
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
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { useDeleteList, useUpdateList } from "@/features/structure/api"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import type { components } from "@/lib/api/schema"
import { NAME_TAKEN_FIELD_ERRORS, reportFormError } from "@/lib/form-errors"
import { structureNameSchema } from "@/lib/validation"
import { topLevelNameSchema } from "./list-form"
import type { ListDto } from "./types"

type UpdateListRequest = components["schemas"]["UpdateListRequest"]

const settingsSchema = z.object({
  name: structureNameSchema,
  top_level_name: topLevelNameSchema,
  production_data: z.boolean(),
})

type SettingsValues = z.infer<typeof settingsSchema>

function settingsValues(list: ListDto): SettingsValues {
  return {
    name: list.name,
    top_level_name: list.top_level_name ?? "",
    production_data: list.production_data,
  }
}

/** Only what `values` changes about `list`, in the shape the update endpoint takes. */
function settingsPatch(list: ListDto, values: SettingsValues): UpdateListRequest {
  const topLevel = values.top_level_name.trim()
  return {
    ...(values.name.trim() !== list.name && { name: values.name.trim() }),
    ...(topLevel !== (list.top_level_name ?? "") && { top_level_name: topLevel || null }),
    ...(values.production_data !== list.production_data && {
      production_data: values.production_data,
    }),
  }
}

interface ListSettingsSheetProps {
  modelId: string
  list: ListDto
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Whether production mode switches the settings off. */
  locked: boolean
  /** Called once the list is deleted, to leave its page. */
  onDeleted: () => void
  /** Called as the sheet closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

/** The name, top level and production data of a list, whether it is numbered, and the way to delete it. */
export function ListSettingsSheet({
  modelId,
  list,
  open,
  onOpenChange,
  locked,
  onDeleted,
  onCloseAutoFocus,
}: ListSettingsSheetProps) {
  const update = useUpdateList(modelId)
  return (
    <Sheet open={open} onOpenChange={closeUnlessBusy(update.isPending, onOpenChange)}>
      <SheetContent
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={!update.isPending}
        className="w-full gap-0 sm:max-w-md"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle>List settings</SheetTitle>
          <SheetDescription>
            What {list.name} is called and how its items are kept.
          </SheetDescription>
        </SheetHeader>
        <ListSettingsForm
          modelId={modelId}
          update={update}
          list={list}
          locked={locked}
          onClose={() => onOpenChange(false)}
          onDeleted={onDeleted}
        />
      </SheetContent>
    </Sheet>
  )
}

interface ListSettingsFormProps {
  modelId: string
  update: ReturnType<typeof useUpdateList>
  list: ListDto
  locked: boolean
  onClose: () => void
  onDeleted: () => void
}

function ListSettingsForm({
  modelId,
  update,
  list,
  locked,
  onClose,
  onDeleted,
}: ListSettingsFormProps) {
  const deleteList = useDeleteList(modelId)
  // The form follows the structure: a field nobody has touched takes the latest saved value, a
  // field being edited keeps what was typed.
  const form = useForm<SettingsValues>({
    resolver: zodResolver(settingsSchema),
    values: settingsValues(list),
    resetOptions: { keepDirtyValues: true },
  })
  const [deleting, setDeleting] = useState(false)
  const { ref: deleteRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()

  async function onSubmit(values: SettingsValues) {
    const patch = settingsPatch(list, values)
    try {
      if (Object.keys(patch).length > 0) {
        await update.mutateAsync({ listId: list.id, body: patch })
        toast.success("List saved")
      }
      onClose()
    } catch (error) {
      reportFormError(form, error, NAME_TAKEN_FIELD_ERRORS)
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
        noValidate
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {locked && <ProductionNotice />}
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input autoComplete="off" disabled={locked} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="top_level_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Top level name</FormLabel>
                <FormControl>
                  <Input autoComplete="off" disabled={locked} {...field} />
                </FormControl>
                <FormDescription>Leave empty for no top level</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="production_data"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between gap-4 rounded-md border p-3">
                <div className="flex flex-col gap-1">
                  <FormLabel>Production data</FormLabel>
                  <FormDescription>
                    The items are data that does not travel with the model's structure.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={locked}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <div className="flex flex-col gap-1 rounded-md border p-3">
            <p className="text-sm leading-none font-medium">
              Numbered: {list.numbered ? "Yes" : "No"}
            </p>
            <p className="text-sm text-muted-foreground">
              {list.numbered
                ? "Items are told apart by their code, so names may repeat."
                : "Item names are unique."}{" "}
              This is set when the list is created and can't be changed.
            </p>
          </div>
          <Separator className="my-2" />
          <section aria-labelledby="delete-list-heading" className="flex flex-col gap-3">
            <h3 id="delete-list-heading" className="text-sm font-semibold">
              Delete list
            </h3>
            <p className="text-sm text-muted-foreground">
              Deleting the list deletes its items. A list that modules, subsets or other lists use
              can't be deleted.
            </p>
            <ProductionLock locked={locked}>
              <Button
                ref={deleteRef}
                type="button"
                variant="outline"
                className="w-fit text-destructive hover:text-destructive"
                disabled={locked || update.isPending}
                onClick={() => setDeleting(true)}
              >
                <Trash2 />
                Delete list
              </Button>
            </ProductionLock>
          </section>
        </div>
        <SheetFooter className="flex-row justify-end border-t">
          <Button type="button" variant="outline" disabled={update.isPending} onClick={onClose}>
            Cancel
          </Button>
          <ProductionLock locked={locked}>
            <Button type="submit" disabled={locked || !form.formState.isDirty || update.isPending}>
              {update.isPending && <Loader2 className="animate-spin" />}
              Save changes
            </Button>
          </ProductionLock>
        </SheetFooter>
      </form>
      <DeleteDialog
        title={`Delete ${list.name}?`}
        description="The list and all of its items are deleted. This can't be done while a module, a subset or another list uses it."
        action="Delete list"
        done="List deleted"
        onConfirm={async () => {
          await deleteList.mutateAsync(list.id)
          onDeleted()
        }}
        open={deleting}
        onOpenChange={setDeleting}
        onCloseAutoFocus={restoreFocus}
      />
    </Form>
  )
}
