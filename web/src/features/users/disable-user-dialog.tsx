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
import { useUpdateUser } from "./api"

interface DisableUserDialogProps {
  user: Pick<components["schemas"]["UserDto"], "id" | "name">
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function DisableUserDialog({
  user,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: DisableUserDialogProps) {
  const updateUser = useUpdateUser()

  async function confirm(event: MouseEvent) {
    // The action would close the dialog straight away; keep it open until the user is disabled.
    event.preventDefault()
    try {
      await updateUser.mutateAsync({ id: user.id, disabled: true })
      toast.success(`${user.name} disabled`)
      onOpenChange(false)
    } catch (error) {
      toast.error(errorDetail(error))
    }
  }

  return (
    // Escape and a click outside end up here too; neither may drop a request in flight.
    <AlertDialog open={open} onOpenChange={(next) => !updateUser.isPending && onOpenChange(next)}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Disable ${user.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {`${user.name} will be signed out everywhere and can't sign in until you enable the account again.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={updateUser.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={updateUser.isPending}
            onClick={confirm}
          >
            {updateUser.isPending && <Loader2 className="animate-spin" />}
            Disable user
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
