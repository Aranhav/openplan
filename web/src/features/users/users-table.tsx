import { KeyRound, Loader2, MoreHorizontal, Pencil, UserCheck, UserX } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { errorDetail } from "@/lib/api/client"
import type { components } from "@/lib/api/schema"
import { useUpdateUser } from "./api"
import { DisableUserDialog } from "./disable-user-dialog"
import { ResetPasswordDialog } from "./reset-password-dialog"
import { UserDialog } from "./user-dialog"

type UserDto = components["schemas"]["UserDto"]

export function UsersTable({ users }: { users: UserDto[] }) {
  const { data: me } = useMe()

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead className="hidden lg:table-cell">Email</TableHead>
            <TableHead className="hidden lg:table-cell">Role</TableHead>
            <TableHead className="hidden lg:table-cell">Status</TableHead>
            <TableHead className="w-12 pr-4">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => {
            const isSelf = user.id === me?.user.id
            return (
              <TableRow key={user.id}>
                <TableCell className="w-full max-w-0 pl-4 lg:w-auto lg:max-w-64">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium" title={user.name}>
                      {user.name}
                    </span>
                    {isSelf && <span className="shrink-0 text-muted-foreground">(you)</span>}
                  </div>
                  {/* Narrow screens have no room for these columns, so they sit under the name. */}
                  <div className="lg:hidden">
                    <div className="truncate text-xs text-muted-foreground" title={user.email}>
                      {user.email}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <RoleBadge user={user} />
                      <StatusBadge user={user} />
                    </div>
                  </div>
                </TableCell>
                <TableCell
                  className="hidden max-w-64 truncate text-muted-foreground lg:table-cell"
                  title={user.email}
                >
                  {user.email}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <RoleBadge user={user} />
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <StatusBadge user={user} />
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <UserActions user={user} isSelf={isSelf} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function RoleBadge({ user }: { user: UserDto }) {
  return user.is_instance_admin ? <Badge>Instance admin</Badge> : null
}

function StatusBadge({ user }: { user: UserDto }) {
  return (
    <Badge variant={user.disabled ? "secondary" : "outline"}>
      {user.disabled ? "Disabled" : "Active"}
    </Badge>
  )
}

interface UserActionsProps {
  user: UserDto
  /** Whether the user is the signed-in one, who can't disable or reset their own account here. */
  isSelf: boolean
}

function UserActions({ user, isSelf }: UserActionsProps) {
  const [dialog, setDialog] = useState<"edit" | "reset" | "disable" | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const updateUser = useUpdateUser()
  // The dialogs open from menu items, which are gone by then: focus returns to the menu's button.
  const { ref: menuButtonRef, onCloseAutoFocus: restoreFocus } =
    useRestoreFocus<HTMLButtonElement>()

  async function enable(event: Event) {
    // Keep the menu open while the request runs, so the spinner shows and a failure leaves it usable.
    event.preventDefault()
    try {
      await updateUser.mutateAsync({ id: user.id, disabled: false })
      toast.success(`${user.name} enabled`)
      setMenuOpen(false)
    } catch (error) {
      toast.error(errorDetail(error))
    }
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={menuButtonRef}
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${user.name}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDialog("edit")}>
            <Pencil />
            Edit
          </DropdownMenuItem>
          {!isSelf && (
            <>
              <DropdownMenuItem onSelect={() => setDialog("reset")}>
                <KeyRound />
                Reset password
              </DropdownMenuItem>
              {user.disabled ? (
                <DropdownMenuItem disabled={updateUser.isPending} onSelect={enable}>
                  {updateUser.isPending ? <Loader2 className="animate-spin" /> : <UserCheck />}
                  Enable
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant="destructive" onSelect={() => setDialog("disable")}>
                  <UserX />
                  Disable
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <UserDialog
        user={user}
        isSelf={isSelf}
        open={dialog === "edit"}
        onOpenChange={(open) => setDialog(open ? "edit" : null)}
        onCloseAutoFocus={restoreFocus}
      />
      {!isSelf && (
        <>
          <ResetPasswordDialog
            user={user}
            open={dialog === "reset"}
            onOpenChange={(open) => setDialog(open ? "reset" : null)}
            onCloseAutoFocus={restoreFocus}
          />
          <DisableUserDialog
            user={user}
            open={dialog === "disable"}
            onOpenChange={(open) => setDialog(open ? "disable" : null)}
            onCloseAutoFocus={restoreFocus}
          />
        </>
      )}
    </>
  )
}

/** A stand-in for the table while the users load. */
export function UsersTableSkeleton() {
  return (
    <div role="status" aria-label="Loading users" className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
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
                <Skeleton className="h-5 w-24 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-16 rounded-full" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
