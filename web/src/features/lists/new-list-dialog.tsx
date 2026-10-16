import { zodResolver } from "@hookform/resolvers/zod"
import { useNavigate } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
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
import { Switch } from "@/components/ui/switch"
import { useCreateList } from "@/features/structure/api"
import type { StructureDto } from "@/features/structure/types"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import { NAME_TAKEN_FIELD_ERRORS, reportFormError } from "@/lib/form-errors"
import { NO_PARENT, type NewListValues, newListSchema } from "./list-form"

const NEW_LIST: NewListValues = {
  name: "",
  parent_list_id: NO_PARENT,
  top_level_name: "",
  numbered: false,
  production_data: false,
}

interface NewListDialogProps {
  modelId: string
  structure: StructureDto
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function NewListDialog({
  modelId,
  structure,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: NewListDialogProps) {
  const createList = useCreateList(modelId)
  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy(createList.isPending, onOpenChange)}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={!createList.isPending}
        className="max-h-[calc(100svh-2rem)] gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>New list</DialogTitle>
          <DialogDescription>
            A list holds the things you plan over, such as regions or products. You add its items
            next.
          </DialogDescription>
        </DialogHeader>
        <NewListForm
          modelId={modelId}
          structure={structure}
          createList={createList}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

interface NewListFormProps {
  modelId: string
  structure: StructureDto
  createList: ReturnType<typeof useCreateList>
  onClose: () => void
}

// A separate component, so the form starts empty each time the dialog opens.
function NewListForm({ modelId, structure, createList, onClose }: NewListFormProps) {
  const navigate = useNavigate()
  const form = useForm<NewListValues>({
    resolver: zodResolver(newListSchema),
    defaultValues: NEW_LIST,
  })

  async function onSubmit(values: NewListValues) {
    try {
      const created = await createList.mutateAsync({
        name: values.name,
        parent_list_id: values.parent_list_id === NO_PARENT ? null : values.parent_list_id,
        top_level_name: values.top_level_name || null,
        numbered: values.numbered,
        production_data: values.production_data,
      })
      toast.success("List created")
      onClose()
      await navigate({ to: "/m/$modelId/lists/$listId", params: { modelId, listId: created.id } })
    } catch (error) {
      reportFormError(form, error, NAME_TAKEN_FIELD_ERRORS)
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
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input placeholder="Regions" autoComplete="off" autoFocus {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="parent_list_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Parent list</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger ref={field.ref} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NO_PARENT}>None</SelectItem>
                    {structure.lists.map((list) => (
                      <SelectItem key={list.id} value={list.id}>
                        {list.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Optional. Each item then belongs to an item of the parent list, as cities belong
                  to countries.
                </FormDescription>
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
                  <Input placeholder="All regions" autoComplete="off" {...field} />
                </FormControl>
                <FormDescription>Leave empty for no top level</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="numbered"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between gap-4 rounded-md border p-3">
                <div className="flex flex-col gap-1">
                  <FormLabel>Numbered</FormLabel>
                  <FormDescription>
                    Items are told apart by their code, so names may repeat. This can't be changed
                    later.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
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
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
        <DialogFooter className="border-t p-4 sm:px-6">
          <Button type="button" variant="outline" disabled={createList.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={createList.isPending}>
            {createList.isPending && <Loader2 className="animate-spin" />}
            Create list
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
