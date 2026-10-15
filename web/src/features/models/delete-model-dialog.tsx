import { Loader2 } from "lucide-react"
import type { MouseEvent } from "react"
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
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function DeleteModelDialog({
  model,
  open,
  onOpenChange,
  onDeleted,
  onCloseAutoFocus,
}: DeleteModelDialogProps) {
  const deleteModel = useDeleteModel()

  async function confirm(event: MouseEvent) {
    // The action would close the dialog straight away; keep it open until the model is gone.
    event.preventDefault()
    try {
      await deleteModel.mutateAsync(model)
      await onDeleted?.()
      toast.success("Model deleted")
      onOpenChange(false)
    } catch (error) {
      toast.error(errorDetail(error))
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {model.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the model and all its data. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
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
