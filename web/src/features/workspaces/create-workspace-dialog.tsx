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
import { ApiError, errorDetail } from "@/lib/api/client"
import { useCreateWorkspace } from "./api"

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Workspace name is required.")
    .max(80, "Workspace name must be at most 80 characters."),
})

type CreateWorkspaceValues = z.infer<typeof schema>

interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateWorkspaceDialog({ open, onOpenChange }: CreateWorkspaceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>
            A workspace holds planning models and the people who work on them.
          </DialogDescription>
        </DialogHeader>
        <CreateWorkspaceForm onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

// A separate component, so the form starts empty each time the dialog opens.
function CreateWorkspaceForm({ onClose }: { onClose: () => void }) {
  const createWorkspace = useCreateWorkspace()
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
      const fieldError = error instanceof ApiError && error.errors.find((e) => e.field === "name")
      if (fieldError) {
        form.setError("name", { message: fieldError.message }, { shouldFocus: true })
      } else {
        toast.error(errorDetail(error))
      }
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
          <Button type="button" variant="outline" onClick={onClose}>
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
