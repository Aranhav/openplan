import { zodResolver } from "@hookform/resolvers/zod"
import { CopyPlus, Loader2, MoreHorizontal, RefreshCw, Save, Star, Trash2, Undo2 } from "lucide-react"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { DeleteDialog } from "@/components/delete-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Form,
  FormControl,
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
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { errorDetail } from "@/lib/api/client"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import { NAME_TAKEN_FIELD_ERRORS, reportFormError } from "@/lib/form-errors"
import { structureNameSchema } from "@/lib/validation"
import type { SavedView, ViewDefinition } from "../view-types"
import { useCreateView, useDeleteView, useUpdateView } from "./views-api"

/** What the select holds for the module's own default pivot, which no saved view stands for. */
const BUILT_IN = "default"

interface SavedViewsProps {
  modelId: string
  moduleId: string
  /** The saved views of the module: the default one first, then by name. */
  views: readonly SavedView[]
  /** The saved views could not be read; the button that replaces the menu tries again. */
  failed?: { retry: () => void }
  /** The view in use, or nothing for the module's own default pivot. */
  saved: SavedView | undefined
  /** The view as it is now, with the changes that are not saved. */
  current: ViewDefinition
  modified: boolean
  /** The user may save, make default and delete views (builders and admins). */
  canSave: boolean
  /** Switches to a view; nothing is the module's default one. */
  onSelect: (viewId: string | undefined) => void
  /** The changes in view are saved or given up: the view in use is as it was saved. */
  onDiscard: () => void
  /** A view is about to be deleted, which the screen that follows the address must not mistake for a view that went missing. */
  onDeleting: (viewId: string) => void
}

/**
 * The saved views of a module: a menu to switch between them, the mark that the view in use has
 * changes that are not saved, and, for builders and admins, saving them over the view or as a
 * new one, making a view the default and deleting it.
 */
export function SavedViews({
  modelId,
  moduleId,
  views,
  failed,
  saved,
  current,
  modified,
  canSave,
  onSelect,
  onDiscard,
  onDeleting,
}: SavedViewsProps) {
  const create = useCreateView(modelId, moduleId)
  const update = useUpdateView(modelId, moduleId)
  const remove = useDeleteView(modelId, moduleId)
  const [dialog, setDialog] = useState<"save-as" | "delete">()
  const { ref: menuRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const busy = create.isPending || update.isPending || remove.isPending
  const hasDefault = views.some((view) => view.is_default)

  async function save() {
    if (!saved) {
      return
    }
    try {
      await update.mutateAsync({ viewId: saved.id, body: { definition: current } })
      toast.success("View saved")
      onDiscard()
    } catch (error) {
      toast.error(errorDetail(error))
    }
  }

  async function makeDefault() {
    if (!saved) {
      return
    }
    try {
      await update.mutateAsync({ viewId: saved.id, body: { is_default: true } })
      toast.success(`${saved.name} is now the default view`)
    } catch (error) {
      toast.error(errorDetail(error))
    }
  }

  if (failed) {
    return (
      <Button variant="outline" size="sm" onClick={failed.retry}>
        <RefreshCw />
        Saved views: retry
      </Button>
    )
  }

  const canDiscard = modified
  const hasActions = canSave || canDiscard

  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={saved?.id ?? BUILT_IN}
        onValueChange={(next) => {
          const view = views.find((candidate) => candidate.id === next)
          // The default view is the one the address leaves out.
          onSelect(view && !view.is_default ? view.id : undefined)
        }}
      >
        <SelectTrigger size="sm" aria-label="Saved view" className="max-w-44 min-w-0 gap-1.5 px-2">
          {/* The name alone: the list says which view is the default, and the button has little room. */}
          <SelectValue>{saved?.name ?? "Default"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {!hasDefault && <SelectItem value={BUILT_IN}>Default</SelectItem>}
          {views.map((view) => (
            <SelectItem key={view.id} value={view.id}>
              {view.name}
              {view.is_default && <span className="text-muted-foreground"> · Default</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span role="status" className="flex">
        {modified && <Badge variant="secondary">Modified</Badge>}
      </span>
      {hasActions && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={menuRef}
              variant="ghost"
              size="icon-sm"
              aria-label="View actions"
              aria-busy={busy || undefined}
              disabled={busy}
            >
              {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canSave && saved && (
              <DropdownMenuItem disabled={!modified} onSelect={() => void save()}>
                <Save />
                Save
              </DropdownMenuItem>
            )}
            {canSave && (
              <DropdownMenuItem onSelect={() => setDialog("save-as")}>
                <CopyPlus />
                Save as…
              </DropdownMenuItem>
            )}
            {canSave && saved && !saved.is_default && (
              <DropdownMenuItem onSelect={() => void makeDefault()}>
                <Star />
                Set as default
              </DropdownMenuItem>
            )}
            {canDiscard && (
              <DropdownMenuItem onSelect={onDiscard}>
                <Undo2 />
                Discard changes
              </DropdownMenuItem>
            )}
            {canSave && saved && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDialog("delete")}>
                  <Trash2 />
                  Delete view…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <SaveAsDialog
        open={dialog === "save-as"}
        onOpenChange={(open) => setDialog(open ? "save-as" : undefined)}
        create={create}
        definition={current}
        onCloseAutoFocus={restoreFocus}
        onCreated={(view) => {
          onDiscard()
          onSelect(view.is_default ? undefined : view.id)
        }}
      />
      {saved && (
        <DeleteDialog
          title="Delete this view?"
          description={`${saved.name} is deleted for everyone who uses this module. This can't be undone.`}
          action="Delete view"
          done="View deleted"
          open={dialog === "delete"}
          onOpenChange={(open) => setDialog(open ? "delete" : undefined)}
          onCloseAutoFocus={restoreFocus}
          onConfirm={async () => {
            onDeleting(saved.id)
            await remove.mutateAsync(saved.id)
            onDiscard()
            onSelect(undefined)
          }}
        />
      )}
    </div>
  )
}

const saveAsSchema = z.object({
  name: structureNameSchema,
  is_default: z.boolean(),
})

type SaveAsValues = z.infer<typeof saveAsSchema>

interface SaveAsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  create: ReturnType<typeof useCreateView>
  definition: ViewDefinition
  onCloseAutoFocus: (event: Event) => void
  onCreated: (view: SavedView) => void
}

function SaveAsDialog({
  open,
  onOpenChange,
  create,
  definition,
  onCloseAutoFocus,
  onCreated,
}: SaveAsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy(create.isPending, onOpenChange)}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={!create.isPending}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Save as a new view</DialogTitle>
          <DialogDescription>
            The pivot, filters, hidden members, formats and column widths as they are now.
          </DialogDescription>
        </DialogHeader>
        <SaveAsForm
          create={create}
          definition={definition}
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </DialogContent>
    </Dialog>
  )
}

// A separate component, so the form starts empty each time the dialog opens.
function SaveAsForm({
  create,
  definition,
  onClose,
  onCreated,
}: {
  create: ReturnType<typeof useCreateView>
  definition: ViewDefinition
  onClose: () => void
  onCreated: (view: SavedView) => void
}) {
  const form = useForm<SaveAsValues>({
    resolver: zodResolver(saveAsSchema),
    defaultValues: { name: "", is_default: false },
  })

  async function onSubmit(values: SaveAsValues) {
    try {
      const view = await create.mutateAsync({
        name: values.name,
        is_default: values.is_default,
        definition,
      })
      toast.success("View saved")
      onClose()
      onCreated(view)
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
                <Input {...field} autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="is_default"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={(next) => field.onChange(next === true)} />
              </FormControl>
              <FormLabel>Set as default</FormLabel>
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending && <Loader2 className="animate-spin" />}
            Save view
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
