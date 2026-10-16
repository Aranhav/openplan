import { Loader2, LogOut, UserMinus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { NAME_CELL, WIDE_CELL } from "@/components/table-layout"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useMe } from "@/features/auth/api"
import { useElementMap } from "@/hooks/use-element-map"
import { useHeadingFocus } from "@/hooks/use-heading-focus"
import { LG_BREAKPOINT, useIsMobile } from "@/hooks/use-mobile"
import { errorDetail } from "@/lib/api/client"
import type { components } from "@/lib/api/schema"
import { cn } from "@/lib/utils"
import { useUpdateMember } from "./api"
import { ChangeOwnRoleDialog } from "./change-own-role-dialog"
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
  const removeButtons = useElementMap<HTMLButtonElement>()
  const heading = useHeadingFocus()
  // The member in the dialog stays put as it closes; only `confirming` says whether it is shown.
  const [removal, setRemoval] = useState<{ member: MemberDto; index: number }>()
  const [confirming, setConfirming] = useState(false)

  // The dialog hands `restoreFocus` to Radix, which keeps the version from before the dialog's last
  // render. That render is the one that also drops the removed member from the list, so the list is
  // read through a ref, which is up to date by the time Radix asks.
  const latest = useRef({ members, removal })
  useEffect(() => {
    latest.current = { members, removal }
  })

  // Hands focus back to the button that opened the dialog. If that member is gone, it goes to
  // whoever took their place in the list (or the one before, at the end). If the whole page is
  // gone (the user just left the workspace), it goes to the heading of the page they landed on.
  function restoreFocus(event: Event) {
    event.preventDefault()
    const { members: listed, removal: opener } = latest.current
    if (!opener) {
      return
    }
    const stillListed = listed.some((member) => member.user_id === opener.member.user_id)
    const focusId = stillListed
      ? opener.member.user_id
      : listed[Math.min(opener.index, listed.length - 1)]?.user_id
    const next = removeButtons.get(focusId) ?? heading()
    next?.focus()
  }

  return (
    <div className="rounded-lg border">
      <Table aria-label="Members">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead className={WIDE_CELL}>Email</TableHead>
            <TableHead className={cn(!canManage && "pr-4")}>Role</TableHead>
            {canManage && (
              <TableHead className="w-12 pr-4">
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member, index) => {
            const isSelf = member.user_id === me?.user.id
            return (
              <TableRow key={member.user_id}>
                <TableCell className={NAME_CELL}>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium" title={member.name}>
                      {member.name}
                    </span>
                    {isSelf && <span className="shrink-0 text-muted-foreground">(you)</span>}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground lg:hidden"
                    title={member.email}
                  >
                    {member.email}
                  </div>
                </TableCell>
                <TableCell
                  className={cn(WIDE_CELL, "max-w-64 truncate text-muted-foreground")}
                  title={member.email}
                >
                  {member.email}
                </TableCell>
                <TableCell className={cn(!canManage && "pr-4")}>
                  <RoleCell
                    workspaceId={workspace.id}
                    member={member}
                    isSelf={isSelf}
                    canManage={canManage}
                  />
                </TableCell>
                {canManage && (
                  <TableCell className="pr-4 text-right">
                    <RemoveButton
                      isSelf={isSelf}
                      name={member.name}
                      buttonRef={removeButtons.refFor(member.user_id)}
                      onClick={() => {
                        setRemoval({ member, index })
                        setConfirming(true)
                      }}
                    />
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {canManage && removal && (
        <RemoveMemberDialog
          workspace={workspace}
          member={removal.member}
          isSelf={removal.member.user_id === me?.user.id}
          open={confirming}
          onOpenChange={setConfirming}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </div>
  )
}

interface RemoveButtonProps {
  isSelf: boolean
  name: string
  buttonRef: (button: HTMLButtonElement | null) => void
  onClick: () => void
}

/** The icon button that opens the dialog for removing a member, or for leaving the workspace. */
function RemoveButton({ isSelf, name, buttonRef, onClick }: RemoveButtonProps) {
  // The table changes layout at `lg` (see `NAME_CELL`), and the button with it.
  const isNarrow = useIsMobile(LG_BREAKPOINT)
  const label = isSelf ? "Leave workspace" : "Remove member"
  const button = (
    <Button
      ref={buttonRef}
      variant="ghost"
      size="icon-sm"
      aria-label={isSelf ? label : `Remove ${name}`}
      onClick={onClick}
    >
      {isSelf ? <LogOut /> : <UserMinus />}
    </Button>
  )

  // A tooltip is for a pointer to hover. On a narrow screen it would only cover the role select
  // beside the button when focus comes back to the button after the dialog closes.
  if (isNarrow) {
    return button
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}

interface RoleCellProps {
  workspaceId: string
  member: MemberDto
  isSelf: boolean
  canManage: boolean
}

function RoleCell({ workspaceId, member, isSelf, canManage }: RoleCellProps) {
  const updateMember = useUpdateMember(workspaceId)
  const trigger = useRef<HTMLButtonElement>(null)
  const heading = useHeadingFocus()
  // The role chosen for yourself, until it is confirmed or dropped.
  const [chosen, setChosen] = useState<WorkspaceRole>()

  if (!canManage) {
    return <Badge variant="secondary">{roleLabels[member.role]}</Badge>
  }

  async function save(role: WorkspaceRole) {
    try {
      await updateMember.mutateAsync({ userId: member.user_id, role })
      toast.success("Role updated")
    } catch (error) {
      // The select shows the saved role again once the request is over, so only say why.
      toast.error(errorDetail(error))
    }
  }

  // The select stays usable while a role is saved (disabling it would drop keyboard focus), so a
  // choice made meanwhile is ignored.
  function choose(role: WorkspaceRole) {
    if (updateMember.isPending) {
      return
    }
    if (isSelf) {
      setChosen(role)
    } else {
      void save(role)
    }
  }

  async function confirmChoice() {
    if (chosen) {
      await save(chosen)
      setChosen(undefined)
    }
  }

  // Back to the select, which is gone if the change took away the right to manage members: then
  // to the heading of the page, which has just turned read-only.
  function restoreFocus(event: Event) {
    event.preventDefault()
    const next = trigger.current ?? heading()
    next?.focus()
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={updateMember.isPending ? updateMember.variables.role : member.role}
        onValueChange={(role) => choose(role as WorkspaceRole)}
      >
        <SelectTrigger
          ref={trigger}
          size="sm"
          className="w-32"
          aria-label={`Role for ${member.name}`}
        >
          <SelectValue />
        </SelectTrigger>
        <RoleSelectContent />
      </Select>
      {updateMember.isPending && (
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
      )}
      {isSelf && (
        <ChangeOwnRoleDialog
          open={chosen !== undefined}
          pending={updateMember.isPending}
          onConfirm={() => void confirmChoice()}
          onOpenChange={(open) => !open && setChosen(undefined)}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </div>
  )
}

/** A stand-in for the table while the members load, with the same columns. */
export function MembersTableSkeleton({ canManage = false }: { canManage?: boolean }) {
  return (
    <div role="status" aria-label="Loading members" className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead className={WIDE_CELL}>Email</TableHead>
            <TableHead className={cn(!canManage && "pr-4")}>Role</TableHead>
            {canManage && <TableHead className="w-12 pr-4" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 4 }, (_, index) => (
            <TableRow key={index}>
              <TableCell className={NAME_CELL}>
                <Skeleton className="h-4 w-32 max-w-full" />
                <Skeleton className="mt-1.5 h-3 w-40 max-w-full lg:hidden" />
              </TableCell>
              <TableCell className={WIDE_CELL}>
                <Skeleton className="h-4 w-44" />
              </TableCell>
              <TableCell className={cn(!canManage && "pr-4")}>
                <Skeleton className="h-8 w-32" />
              </TableCell>
              {canManage && (
                <TableCell className="pr-4">
                  <Skeleton className="size-8" />
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
