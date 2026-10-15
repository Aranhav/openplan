import { Loader2 } from "lucide-react"
import type { MouseEvent } from "react"
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

interface ChangeOwnRoleDialogProps {
  open: boolean
  /** Whether the change is being saved; the dialog can't be dismissed until it is done. */
  pending: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus: (event: Event) => void
}

/** A change to your own role can take away the ability to manage the workspace, so it is confirmed. */
export function ChangeOwnRoleDialog({
  open,
  pending,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
}: ChangeOwnRoleDialogProps) {
  function confirm(event: MouseEvent) {
    // The action would close the dialog straight away; keep it open until the change is saved.
    event.preventDefault()
    onConfirm()
  }

  return (
    // Escape and a click outside end up here too; neither may drop a request in flight.
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Change your own role?</AlertDialogTitle>
          <AlertDialogDescription>
            You may lose the ability to manage this workspace.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={confirm}>
            {pending && <Loader2 className="animate-spin" />}
            Change role
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
