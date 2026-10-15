import { KeyRound, Loader2, MoreHorizontal, Pencil, UserCheck, UserX } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { NAME_CELL, WIDE_CELL } from "@/components/table-layout"
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
import { useElementMap } from "@/hooks/use-element-map"
import { errorDetail } from "@/lib/api/client"
import type { components } from "@/lib/api/schema"
import { cn } from "@/lib/utils"
import { useUpdateUser } from "./api"
import { DisableUserDialog } from "./disable-user-dialog"
import { ResetPasswordDialog } from "./reset-password-dialog"
import { UserDialog } from "./user-dialog"

type UserDto = components["schemas"]["UserDto"]

type UserDialogKind = "edit" | "reset" | "disable"

export function UsersTable({ users }: { users: UserDto[] }) {
  const { data: me } = useMe()
  const menuButtons = useElementMap<HTMLButtonElement>()
  // The user in the dialogs stays put as one closes; only `dialog` says which one is shown.
  const [targetId, setTargetId] = useState<string>()
  const [dialog, setDialog] = useState<UserDialogKind>()
  // Looked up in the list, so a dialog that is open follows the user as the list refreshes.
  const target = users.find((user) => user.id === targetId)

  function open(kind: UserDialogKind, user: UserDto) {
    setTargetId(user.id)
    setDialog(kind)
  }

  // The dialogs open from menu items, which are gone by then: focus returns to the menu's button.
  function restoreFocus(event: Event) {
    event.preventDefault()
    menuButtons.get(targetId)?.focus()
  }

  function onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      setDialog(undefined)
    }
  }

  return (
    <div className="rounded-lg border">
      <Table aria-label="Users">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead className={WIDE_CELL}>Email</TableHead>
            <TableHead className={WIDE_CELL}>Role</TableHead>
            <TableHead className={WIDE_CELL}>Status</TableHead>
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
                <TableCell className={NAME_CELL}>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium" title={user.name}>
                      {user.name}
                    </span>
                    {isSelf && <span className="shrink-0 text-muted-foreground">(you)</span>}
                  </div>
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
                  className={cn(WIDE_CELL, "max-w-64 truncate text-muted-foreground")}
                  title={user.email}
                >
                  {user.email}
                </TableCell>
                <TableCell className={WIDE_CELL}>
                  <RoleBadge user={user} />
                </TableCell>
                <TableCell className={WIDE_CELL}>
                  <StatusBadge user={user} />
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <UserActions
                    user={user}
                    isSelf={isSelf}
                    buttonRef={menuButtons.refFor(user.id)}
                    onOpen={(kind) => open(kind, user)}
                  />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {target && (
        <>
          <UserDialog
            user={target}
            isSelf={target.id === me?.user.id}
            open={dialog === "edit"}
            onOpenChange={onOpenChange}
            onCloseAutoFocus={restoreFocus}
          />
          <ResetPasswordDialog
            user={target}
            open={dialog === "reset"}
            onOpenChange={onOpenChange}
            onCloseAutoFocus={restoreFocus}
          />
          <DisableUserDialog
            user={target}
            open={dialog === "disable"}
            onOpenChange={onOpenChange}
            onCloseAutoFocus={restoreFocus}
          />
        </>
      )}
    </div>
  )
}

function RoleBadge({ user }: { user: UserDto }) {
  return user.is_instance_admin ? (
    <Badge>Instance admin</Badge>
  ) : (
    <Badge variant="outline">Member</Badge>
  )
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
  buttonRef: (button: HTMLButtonElement | null) => void
  onOpen: (dialog: UserDialogKind) => void
}

function UserActions({ user, isSelf, buttonRef, onOpen }: UserActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const updateUser = useUpdateUser()

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
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={buttonRef}
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${user.name}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onOpen("edit")}>
          <Pencil />
          Edit
        </DropdownMenuItem>
        {!isSelf && (
          <>
            <DropdownMenuItem onSelect={() => onOpen("reset")}>
              <KeyRound />
              Reset password
            </DropdownMenuItem>
            {user.disabled ? (
              <DropdownMenuItem disabled={updateUser.isPending} onSelect={enable}>
                {updateUser.isPending ? <Loader2 className="animate-spin" /> : <UserCheck />}
                Enable
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem variant="destructive" onSelect={() => onOpen("disable")}>
                <UserX />
                Disable
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A stand-in for the table while the users load, with the same columns. */
export function UsersTableSkeleton() {
  return (
    <div role="status" aria-label="Loading users" className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead className={WIDE_CELL}>Email</TableHead>
            <TableHead className={WIDE_CELL}>Role</TableHead>
            <TableHead className={WIDE_CELL}>Status</TableHead>
            <TableHead className="w-12 pr-4" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 4 }, (_, index) => (
            <TableRow key={index}>
              <TableCell className={NAME_CELL}>
                <Skeleton className="h-4 w-32 max-w-full" />
                <div className="lg:hidden">
                  <Skeleton className="mt-1.5 h-3 w-40 max-w-full" />
                  <Skeleton className="mt-2 h-5 w-16 rounded-full" />
                </div>
              </TableCell>
              <TableCell className={WIDE_CELL}>
                <Skeleton className="h-4 w-44" />
              </TableCell>
              <TableCell className={WIDE_CELL}>
                <Skeleton className="h-5 w-24 rounded-full" />
              </TableCell>
              <TableCell className={WIDE_CELL}>
                <Skeleton className="h-5 w-16 rounded-full" />
              </TableCell>
              <TableCell className="pr-4">
                <Skeleton className="size-8" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
