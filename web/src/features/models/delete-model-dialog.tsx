import { Loader2 } from "lucide-react"
import { type MouseEvent, useRef } from "react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { errorDetail } from "@/lib/api/client"
import type { components } from "@/lib/api/schema"
import { useDeleteModel } from "./api"

interface DeleteModelDialogProps {
  model: Pick<components["schemas"]["ModelDto"], "id" | "name" | "workspace_id">
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Runs once the model is gone, before the confirmation toast: the place to leave its page. */
  onDeleted?: () => unknown
  /** Called as the dialog closes without a deletion. Preventing it stops focus returning. */
  onCloseAutoFocus?: (event: Event) => void
  /**
   * Where focus goes once the dialog is gone after a deletion, when whatever opened it (its page
   * or card) is gone too. It runs as the dialog closes, so what it names can be on a new page.
   */
  focusAfterDelete?: () => HTMLElement | null | undefined
}

export function DeleteModelDialog({
  model,
  open,
  onOpenChange,
  onDeleted,
  onCloseAutoFocus,
  focusAfterDelete,
}: DeleteModelDialogProps) {
  const deleteModel = useDeleteModel()
  const deleted = useRef(false)

  async function confirm(event: MouseEvent) {
    // The action would close the dialog straight away; keep it open until the model is gone.
    event.preventDefault()
    try {
      await deleteModel.mutateAsync(model)
      deleted.current = true
      await onDeleted?.()
      toast.success("Model deleted")
      onOpenChange(false)
    } catch (error) {
      toast.error(errorDetail(error))
    }
  }

  // Escape would otherwise close the dialog while the model is still being deleted.
  function closeUnlessBusy(next: boolean) {
    if (!deleteModel.isPending) {
      onOpenChange(next)
    }
  }

  function restoreFocus(event: Event) {
    if (deleted.current) {
      event.preventDefault()
      focusAfterDelete?.()?.focus()
    } else {
      onCloseAutoFocus?.(event)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={closeUnlessBusy}>
      <AlertDialogContent onCloseAutoFocus={restoreFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {model.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the model and all its data. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteModel.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteModel.isPending}
            onClick={confirm}
          >
            {deleteModel.isPending && <Loader2 className="animate-spin" />}
            Delete model
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
