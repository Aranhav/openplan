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
import { closeUnlessBusy } from "@/lib/close-unless-busy"
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
  // The request is over once the model is gone, but the dialog stays locked while `onDeleted`
  // leaves its page and until it closes: a second deletion would only fail.
  const busy = deleteModel.isPending || deleteModel.isSuccess

  async function confirm(event: MouseEvent) {
    // The action would close the dialog straight away; keep it open until the model is gone.
    event.preventDefault()
    if (deleted.current) {
      return
    }
    try {
      await deleteModel.mutateAsync(model)
      deleted.current = true
      await onDeleted?.()
      toast.success("Model deleted")
      onOpenChange(false)
    } catch (error) {
      toast.error(errorDetail(error))
      // The model is gone, so a failure to leave its page must not strand a locked dialog.
      if (deleted.current) {
        onOpenChange(false)
      }
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
    <AlertDialog open={open} onOpenChange={closeUnlessBusy(busy, onOpenChange)}>
      <AlertDialogContent onCloseAutoFocus={restoreFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {model.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the model and all its data. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={confirm}>
            {deleteModel.isPending && <Loader2 className="animate-spin" />}
            Delete model
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
