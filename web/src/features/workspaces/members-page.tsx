import { UserPlus } from "lucide-react"
import { useState } from "react"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import type { components } from "@/lib/api/schema"
import { AddMemberDialog } from "./add-member-dialog"
import { useMembers } from "./api"
import { MembersTable, MembersTableSkeleton } from "./members-table"
import { canManageMembers } from "./roles"
import { WorkspaceNotFound } from "./workspace-not-found"

export function MembersPage({ workspaceId }: { workspaceId: string }) {
  const { workspace, isLoading } = useCurrentWorkspace()

  if (isLoading) {
    return (
      <>
        <PageHeader title="Members" />
        <MembersTableSkeleton />
      </>
    )
  }
  // The current workspace falls back to another one when the address names none the user is in.
  if (workspace?.id !== workspaceId) {
    return <WorkspaceNotFound />
  }
  return <WorkspaceMembers workspace={workspace} />
}

function WorkspaceMembers({ workspace }: { workspace: components["schemas"]["WorkspaceSummary"] }) {
  const members = useMembers(workspace.id)
  const [adding, setAdding] = useState(false)
  const { ref: addRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const canManage = canManageMembers(workspace.role)

  return (
    <>
      <PageHeader
        title="Members"
        description={`People who can access ${workspace.name}.`}
        actions={
          canManage &&
          members.data && (
            <Button ref={addRef} onClick={() => setAdding(true)}>
              <UserPlus />
              Add member
            </Button>
          )
        }
      />
      {/* A refresh that fails in the background leaves the members already on screen alone. */}
      {members.data ? (
        <MembersTable workspace={workspace} members={members.data} canManage={canManage} />
      ) : members.isError ? (
        <ErrorState
          error={members.error}
          isFetching={members.isFetching}
          onRetry={() => void members.refetch()}
        />
      ) : (
        <MembersTableSkeleton canManage={canManage} />
      )}
      {canManage && (
        <AddMemberDialog
          workspaceId={workspace.id}
          open={adding}
          onOpenChange={setAdding}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </>
  )
}
