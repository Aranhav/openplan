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
import { Form } from "@/components/ui/form"
import type { components } from "@/lib/api/schema"
import { useUpdateModel } from "./api"
import { ModelNameField } from "./model-fields"
import { modelNameSchema, reportModelFormError } from "./model-form"

const schema = z.object({ name: modelNameSchema })

type RenameModelValues = z.infer<typeof schema>

interface RenameModelDialogProps {
  model: Pick<components["schemas"]["ModelDto"], "id" | "name">
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function RenameModelDialog({
  model,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: RenameModelDialogProps) {
  const updateModel = useUpdateModel(model.id)
  // Nothing closes the dialog while the rename is being saved: Escape, a click outside and the
  // close button would hide a request that is still running.
  const closeUnlessBusy = (next: boolean) => {
    if (!updateModel.isPending) {
      onOpenChange(next)
    }
  }
  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} showCloseButton={!updateModel.isPending}>
        <DialogHeader>
          <DialogTitle>Rename model</DialogTitle>
          <DialogDescription>Each model in a workspace needs its own name.</DialogDescription>
        </DialogHeader>
        <RenameModelForm
          model={model}
          updateModel={updateModel}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

// A separate component, so the form starts from the model's current name on every opening.
function RenameModelForm({
  model,
  updateModel,
  onClose,
}: {
  model: RenameModelDialogProps["model"]
  updateModel: ReturnType<typeof useUpdateModel>
  onClose: () => void
}) {
  const form = useForm<RenameModelValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: model.name },
  })

  async function onSubmit({ name }: RenameModelValues) {
    if (name === model.name) {
      onClose()
      return
    }
    try {
      await updateModel.mutateAsync({ name })
      toast.success("Model renamed")
      onClose()
    } catch (error) {
      reportModelFormError(form, error)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <ModelNameField autoFocus />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={updateModel.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={updateModel.isPending}>
            {updateModel.isPending && <Loader2 className="animate-spin" />}
            Rename model
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
