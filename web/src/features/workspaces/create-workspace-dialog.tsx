import { zodResolver } from "@hookform/resolvers/zod"
import { useNavigate } from "@tanstack/react-router"
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
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import { reportFormError } from "@/lib/form-errors"
import { workspaceNameSchema } from "@/lib/validation"
import { useCreateWorkspace } from "./api"

const schema = z.object({ name: workspaceNameSchema })

type CreateWorkspaceValues = z.infer<typeof schema>

interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: CreateWorkspaceDialogProps) {
  const createWorkspace = useCreateWorkspace()
  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy(createWorkspace.isPending, onOpenChange)}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={!createWorkspace.isPending}
      >
        <DialogHeader>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>
            A workspace holds planning models and the people who work on them.
          </DialogDescription>
        </DialogHeader>
        <CreateWorkspaceForm
          createWorkspace={createWorkspace}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

// A separate component, so the form starts empty each time the dialog opens.
function CreateWorkspaceForm({
  createWorkspace,
  onClose,
}: {
  createWorkspace: ReturnType<typeof useCreateWorkspace>
  onClose: () => void
}) {
  const navigate = useNavigate()
  const form = useForm<CreateWorkspaceValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "" },
  })

  async function onSubmit(values: CreateWorkspaceValues) {
    try {
      const workspace = await createWorkspace.mutateAsync(values)
      toast.success("Workspace created")
      onClose()
      await navigate({ to: "/w/$workspaceId", params: { workspaceId: workspace.id } })
    } catch (error) {
      reportFormError(form, error)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Workspace name</FormLabel>
              <FormControl>
                <Input placeholder="Acme Corp" autoComplete="organization" autoFocus {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={createWorkspace.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createWorkspace.isPending}>
            {createWorkspace.isPending && <Loader2 className="animate-spin" />}
            Create workspace
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
