import { Loader2, UserMinus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useMe } from "@/features/auth/api"
import { errorDetail } from "@/lib/api/client"
import type { components } from "@/lib/api/schema"
import { cn } from "@/lib/utils"
import { useUpdateMember } from "./api"
import { RemoveMemberDialog } from "./remove-member-dialog"
import { RoleSelectContent } from "./role-select-content"
import { type WorkspaceRole, roleLabels } from "./roles"

type MemberDto = components["schemas"]["MemberDto"]
type WorkspaceSummary = components["schemas"]["WorkspaceSummary"]

interface MembersTableProps {
  workspace: WorkspaceSummary
  members: MemberDto[]
  /** Whether the signed-in user may change roles and remove members. */
  canManage: boolean
}

export function MembersTable({ workspace, members, canManage }: MembersTableProps) {
  const { data: me } = useMe()
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())
  // The member in the dialog stays put as it closes; only `confirming` says whether it is shown.
  const [target, setTarget] = useState<{ member: MemberDto; index: number }>()
  const [confirming, setConfirming] = useState(false)

  // The dialog hands this to Radix, which keeps the version from before the dialog's last render.
  // That render is the one that also drops the removed member from the list, so the list is read
  // through a ref, which is up to date by the time Radix asks.
  const latest = useRef({ members, target })
  useEffect(() => {
    latest.current = { members, target }
  })

  // Hands focus back to the button that opened the dialog. If that member is gone, it goes to
  // whoever took their place in the list (or the one before, at the end). If the whole page is
  // gone (the user just left the workspace), it goes to the heading of the page they landed on.
  function restoreFocus(event: Event) {
    event.preventDefault()
    const { members: current, target: opener } = latest.current
    if (!opener) {
      return
    }
    const stillListed = current.some((member) => member.user_id === opener.member.user_id)
    const focusId = stillListed
      ? opener.member.user_id
      : current[Math.min(opener.index, current.length - 1)]?.user_id
    const target = removeButtons.current.get(focusId ?? "") ?? document.querySelector("h1")
    target?.focus()
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead className="hidden lg:table-cell">Email</TableHead>
            <TableHead className={cn(!canManage && "pr-4")}>Role</TableHead>
            {canManage && (
              <TableHead className="w-12 pr-4">
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member, index) => (
            <TableRow key={member.user_id}>
              <TableCell className="w-full max-w-0 pl-4 lg:w-auto lg:max-w-64">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium" title={member.name}>
                    {member.name}
                  </span>
                  {member.user_id === me?.user.id && (
                    <span className="shrink-0 text-muted-foreground">(you)</span>
                  )}
                </div>
                {/* Narrow screens have no room for an Email column, so the email sits under the name. */}
                <div
                  className="truncate text-xs text-muted-foreground lg:hidden"
                  title={member.email}
                >
                  {member.email}
                </div>
              </TableCell>
              <TableCell
                className="hidden max-w-64 truncate text-muted-foreground lg:table-cell"
                title={member.email}
              >
                {member.email}
              </TableCell>
              <TableCell className={cn(!canManage && "pr-4")}>
                <RoleCell workspaceId={workspace.id} member={member} canManage={canManage} />
              </TableCell>
              {canManage && (
                <TableCell className="pr-4 text-right">
                  <Button
                    ref={(button) => {
                      if (button) {
                        removeButtons.current.set(member.user_id, button)
                      } else {
                        removeButtons.current.delete(member.user_id)
                      }
                    }}
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${member.name}`}
                    onClick={() => {
                      setTarget({ member, index })
                      setConfirming(true)
                    }}
                  >
                    <UserMinus />
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {canManage && target && (
        <RemoveMemberDialog
          workspace={workspace}
          member={target.member}
          isSelf={target.member.user_id === me?.user.id}
          open={confirming}
          onOpenChange={setConfirming}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </div>
  )
}

interface RoleCellProps {
  workspaceId: string
  member: MemberDto
  canManage: boolean
}

function RoleCell({ workspaceId, member, canManage }: RoleCellProps) {
  const updateMember = useUpdateMember(workspaceId)

  if (!canManage) {
    return <Badge variant="secondary">{roleLabels[member.role]}</Badge>
  }

  async function changeRole(role: WorkspaceRole) {
    try {
      await updateMember.mutateAsync({ userId: member.user_id, role })
      toast.success("Role updated")
    } catch (error) {
      // The select shows the saved role again once the request is over, so only say why.
      toast.error(errorDetail(error))
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={updateMember.isPending ? updateMember.variables.role : member.role}
        onValueChange={(role) => void changeRole(role as WorkspaceRole)}
        disabled={updateMember.isPending}
      >
        <SelectTrigger size="sm" className="w-32" aria-label={`Role for ${member.name}`}>
          <SelectValue />
        </SelectTrigger>
        <RoleSelectContent />
      </Select>
      {updateMember.isPending && (
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
      )}
    </div>
  )
}

/** A stand-in for the table while the members load. */
export function MembersTableSkeleton() {
  return (
    <div role="status" aria-label="Loading members" className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 4 }, (_, index) => (
            <TableRow key={index}>
              <TableCell className="pl-4">
                <Skeleton className="h-4 w-32" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-44" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-8 w-32" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
