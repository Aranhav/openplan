import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select"
import { reportFormError } from "@/lib/form-errors"
import { emailSchema } from "@/lib/validation"
import { useAddMember } from "./api"
import { RoleSelectContent } from "./role-select-content"
import { roleOptions } from "./roles"

const schema = z.object({
  email: emailSchema,
  role: z.enum(roleOptions),
})

type AddMemberValues = z.infer<typeof schema>

interface AddMemberDialogProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function AddMemberDialog({
  workspaceId,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: AddMemberDialogProps) {
  const addMember = useAddMember(workspaceId)
  return (
    // Escape, the close button and a click outside all end up here; none may drop a request in flight.
    <Dialog open={open} onOpenChange={(next) => !addMember.isPending && onOpenChange(next)}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>
            Add someone who already has an OpenPlan account to this workspace.
          </DialogDescription>
        </DialogHeader>
        <AddMemberForm addMember={addMember} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

// A separate component, so the form starts empty each time the dialog opens.
function AddMemberForm({
  addMember,
  onClose,
}: {
  addMember: ReturnType<typeof useAddMember>
  onClose: () => void
}) {
  const form = useForm<AddMemberValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", role: "planner" },
  })

  async function onSubmit(values: AddMemberValues) {
    try {
      const member = await addMember.mutateAsync(values)
      toast.success(`${member.name} added`)
      onClose()
    } catch (error) {
      reportFormError(form, error, {
        "user.not_found": "email",
        "workspace.member_exists": "email",
      })
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="name@company.com"
                  autoComplete="off"
                  autoFocus
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="role"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Role</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <RoleSelectContent />
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={addMember.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={addMember.isPending}>
            {addMember.isPending && <Loader2 className="animate-spin" />}
            Add member
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
