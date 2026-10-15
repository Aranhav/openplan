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
import { useMe } from "@/features/auth/api"
import { errorDetail } from "@/lib/api/client"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import type { components } from "@/lib/api/schema"
import { useRemoveMember } from "./api"

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
  const { data: me } = useMe()
  // An instance admin is an admin of every workspace, so leaving one takes nothing away from them.
  const keepsAccess = me?.user.is_instance_admin === true
  const removeMember = useRemoveMember(workspace.id, { leaving: isSelf && !keepsAccess })

  let description = `${member.name} will lose access to this workspace and its models. You can add them again later.`
  if (isSelf) {
    description = keepsAccess
      ? "You'll stay an instance admin, so you can still open this workspace."
      : "You'll lose access to this workspace and its models. Another admin can add you back."
  }

  async function confirm(event: MouseEvent) {
    // The action would close the dialog straight away; keep it open until the member is gone.
    event.preventDefault()
    try {
      await removeMember.mutateAsync(member.user_id)
      toast.success(isSelf ? `You left ${workspace.name}` : `${member.name} removed`)
      onOpenChange(false)
    } catch (error) {
      toast.error(errorDetail(error))
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={closeUnlessBusy(removeMember.isPending, onOpenChange)}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isSelf ? `Leave ${workspace.name}?` : `Remove ${member.name} from ${workspace.name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removeMember.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={removeMember.isPending}
            onClick={confirm}
          >
            {removeMember.isPending && <Loader2 className="animate-spin" />}
            {isSelf ? "Leave workspace" : "Remove member"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
