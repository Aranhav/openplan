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
import { Form } from "@/components/ui/form"
import { useCreateModel } from "./api"
import { ModelDescriptionField, ModelNameField } from "./model-fields"
import { modelDescriptionSchema, modelNameSchema, reportModelFormError } from "./model-form"

const schema = z.object({ name: modelNameSchema, description: modelDescriptionSchema })

type CreateModelValues = z.infer<typeof schema>

interface CreateModelDialogProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function CreateModelDialog({
  workspaceId,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: CreateModelDialogProps) {
  const createModel = useCreateModel(workspaceId)
  // Nothing closes the dialog while the model is being created: Escape, a click outside and the
  // close button would hide a request that is still running.
  const closeUnlessBusy = (next: boolean) => {
    if (!createModel.isPending) {
      onOpenChange(next)
    }
  }
  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} showCloseButton={!createModel.isPending}>
        <DialogHeader>
          <DialogTitle>Create model</DialogTitle>
          <DialogDescription>
            Give your planning model a name. You can change it later.
          </DialogDescription>
        </DialogHeader>
        <CreateModelForm createModel={createModel} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

// A separate component, so the form starts empty each time the dialog opens.
function CreateModelForm({
  createModel,
  onClose,
}: {
  createModel: ReturnType<typeof useCreateModel>
  onClose: () => void
}) {
  const navigate = useNavigate()
  const form = useForm<CreateModelValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", description: "" },
  })

  async function onSubmit(values: CreateModelValues) {
    try {
      const model = await createModel.mutateAsync(values)
      toast.success("Model created")
      onClose()
      await navigate({ to: "/m/$modelId", params: { modelId: model.id } })
    } catch (error) {
      reportModelFormError(form, error)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <ModelNameField autoFocus />
        <ModelDescriptionField />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={createModel.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createModel.isPending}>
            {createModel.isPending && <Loader2 className="animate-spin" />}
            Create model
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
