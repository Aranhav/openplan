import { Link } from "@tanstack/react-router"
import { House, Lock, Plus } from "lucide-react"
import { useState } from "react"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { useMe } from "@/features/auth/api"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { useUsers } from "./api"
import { UserDialog } from "./user-dialog"
import { UsersTable, UsersTableSkeleton } from "./users-table"

export function UsersPage() {
  const { data: me } = useMe()

  if (!me) {
    return (
      <>
        <PageHeader title="Users" />
        <UsersTableSkeleton />
      </>
    )
  }
  return me.user.is_instance_admin ? <UserAdmin /> : <NoAccess />
}

function NoAccess() {
  useDocumentTitle("No access · OpenPlan")
  return (
    <EmptyState
      icon={Lock}
      title="You don't have access to this page"
      description="Only instance admins can manage users."
      action={
        <Button asChild>
          <Link to="/">
            <House />
            Go home
          </Link>
        </Button>
      }
      headingLevel={1}
    />
  )
}

function UserAdmin() {
  const users = useUsers()
  const [creating, setCreating] = useState(false)
  const { ref: newUserRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone with an account on this OpenPlan instance."
        actions={
          users.data && (
            <Button ref={newUserRef} onClick={() => setCreating(true)}>
              <Plus />
              New user
            </Button>
          )
        }
      />
      {/* A refresh that fails in the background leaves the users already on screen alone. */}
      {users.data ? (
        <UsersTable users={users.data} />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : (
        <UsersTableSkeleton />
      )}
      <UserDialog open={creating} onOpenChange={setCreating} onCloseAutoFocus={restoreFocus} />
    </>
  )
}
