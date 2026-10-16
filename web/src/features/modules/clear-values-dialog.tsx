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
import { closeUnlessBusy } from "@/lib/close-unless-busy"

interface ClearValuesDialogProps {
  open: boolean
  /** Why the values go: "Changing dimensions clears this module's input values." */
  description: string
  /** Whether the change is being saved; the dialog can't be dismissed until it is done. */
  pending: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

/** A change to a structure that wipes the values typed into it is confirmed before it is saved. */
export function ClearValuesDialog({
  open,
  description,
  pending,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
}: ClearValuesDialogProps) {
  function confirm(event: MouseEvent) {
    // The action would close the dialog straight away; keep it open until the change is saved.
    event.preventDefault()
    onConfirm()
  }

  return (
    <AlertDialog open={open} onOpenChange={closeUnlessBusy(pending, onOpenChange)}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear input values?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={confirm}>
            {pending && <Loader2 className="animate-spin" />}
            Save and clear values
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
