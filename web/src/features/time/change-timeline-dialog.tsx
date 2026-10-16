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

interface ChangeTimelineDialogProps {
  open: boolean
  /** Whether the calendar is being saved; the dialog can't be dismissed until it is done. */
  pending: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus: (event: Event) => void
}

/** A different start month or number of years moves every period, so the change is confirmed first. */
export function ChangeTimelineDialog({
  open,
  pending,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
}: ChangeTimelineDialogProps) {
  function confirm(event: MouseEvent) {
    // The action would close the dialog straight away; keep it open until the calendar is saved.
    event.preventDefault()
    onConfirm()
  }

  return (
    <AlertDialog open={open} onOpenChange={closeUnlessBusy(pending, onOpenChange)}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Change the timeline?</AlertDialogTitle>
          <AlertDialogDescription>
            Changing the timeline clears input values on line items that use Time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={confirm}>
            {pending && <Loader2 className="animate-spin" />}
            Change timeline
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
