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
import { useLeaveWorkspace, useRemoveMember } from "./api"

interface RemoveMemberDialogProps {
  workspace: Pick<components["schemas"]["WorkspaceSummary"], "id" | "name">
  member: Pick<components["schemas"]["MemberDto"], "user_id" | "name">
  /** Whether the member is the signed-in user, who is then leaving the workspace. */
  isSelf: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function RemoveMemberDialog({
  workspace,
  member,
  isSelf,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: RemoveMemberDialogProps) {
  const removeMember = useRemoveMember(workspace.id)
  const leaveWorkspace = useLeaveWorkspace(workspace.id)
  // Removing yourself also takes you off the workspace's pages.
  const removal = isSelf ? leaveWorkspace : removeMember

  async function confirm(event: MouseEvent) {
    // The action would close the dialog straight away; keep it open until the member is gone.
    event.preventDefault()
    try {
      await removal.mutateAsync(member.user_id)
      toast.success(isSelf ? `You left ${workspace.name}` : `${member.name} removed`)
      onOpenChange(false)
    } catch (error) {
      toast.error(errorDetail(error))
    }
  }

  return (
    // Escape and a click outside end up here too; neither may drop a request in flight.
    <AlertDialog open={open} onOpenChange={(next) => !removal.isPending && onOpenChange(next)}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Remove ${member.name} from ${workspace.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {isSelf
              ? "You'll lose access to this workspace and its models. Another admin can add you back."
              : `${member.name} will lose access to this workspace and its models. You can add them again later.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removal.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={removal.isPending} onClick={confirm}>
            {removal.isPending && <Loader2 className="animate-spin" />}
            Remove member
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
