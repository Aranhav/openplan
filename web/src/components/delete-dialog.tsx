import { Loader2 } from "lucide-react"
import { type MouseEvent, useState } from "react"
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

interface DeleteDialogProps {
  title: string
  description: string
  /** The button that deletes, such as "Delete version". */
  action: string
  /** The toast that follows a deletion. */
  done: string
  /** Deletes the thing; a refusal it throws is shown in a toast and leaves the dialog open. */
  onConfirm: () => Promise<unknown>
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

/** Asks before something is deleted for good, and keeps the dialog open while the request runs. */
export function DeleteDialog({
  title,
  description,
  action,
  done,
  onConfirm,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: DeleteDialogProps) {
  const [pending, setPending] = useState(false)

  async function confirm(event: MouseEvent) {
    // The action would close the dialog straight away; keep it open until the request is over.
    event.preventDefault()
    setPending(true)
    try {
      await onConfirm()
      toast.success(done)
      onOpenChange(false)
    } catch (error) {
      toast.error(errorDetail(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={closeUnlessBusy(pending, onOpenChange)}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={confirm}>
            {pending && <Loader2 className="animate-spin" />}
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
