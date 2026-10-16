import { Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, Folder, Grid3x3, Settings } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { ProductionLock, ProductionNotice } from "@/components/production-lock"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LiveIndicator } from "@/features/live/live-indicator"
import { useStructure, useUpdateModule } from "@/features/structure/api"
import { axisLabel } from "@/features/structure/labels"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import { canEditCells } from "@/features/workspaces/roles"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { useStructureAccess } from "@/hooks/use-structure-access"
import { Blueprint } from "./blueprint"
import { ModuleGrid } from "./module-grid"
import { ModuleSettingsSheet } from "./module-settings-sheet"
import { ModuleTitle } from "./module-title"

type ModuleTab = "grid" | "blueprint"

interface ModulePageProps {
  modelId: string
  moduleId: string
  tab: ModuleTab
  onTabChange: (tab: ModuleTab) => void
  /** The selected line item of the Blueprint, from the address. */
  selectedLineItemId?: string
  onSelectLineItem: (id: string | undefined) => void
  /** The saved view of the Grid tab, from the address; none is the module's default view. */
  viewId?: string
  onViewChange: (viewId: string | undefined, options?: { replace?: boolean }) => void
}

export function ModulePage({ modelId, moduleId, ...rest }: ModulePageProps) {
  const structure = useStructure(modelId)
  const { isLoading } = useStructureAccess(modelId)
  // The module waits for the user's role too, so the controls of a builder do not appear late.
  const loaded = isLoading ? undefined : structure.data
  const module = loaded?.modules.find((candidate) => candidate.id === moduleId)

  if (module && loaded) {
    return <ModuleScreen modelId={modelId} module={module} structure={loaded} {...rest} />
  }
  if (loaded && !structure.isFetching) {
    return <ModuleNotFound modelId={modelId} />
  }
  if (structure.isError) {
    return (
      <>
        <PageHeader title="Module" />
        <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
      </>
    )
  }
  // The structure is on its way, or the module just left it and the page is about to leave too.
  return (
    <>
      <PageHeader title="Module" />
      <div role="status" aria-label="Loading module" className="rounded-lg border">
        <div className="flex flex-col gap-4 p-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 flex-1" />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function ModuleNotFound({ modelId }: { modelId: string }) {
  useDocumentTitle("Module not found · OpenPlan")
  return (
    <EmptyState
      icon={Grid3x3}
      title="Module not found"
      description="It may have been deleted."
      action={
        <Button asChild>
          <Link to="/m/$modelId/modules" params={{ modelId }}>
            <ArrowLeft />
            Back to modules
          </Link>
        </Button>
      }
      headingLevel={1}
    />
  )
}

interface ModuleScreenProps extends Omit<ModulePageProps, "moduleId"> {
  module: ModuleDto
  structure: StructureDto
}

function ModuleScreen({
  modelId,
  module,
  structure,
  tab,
  onTabChange,
  selectedLineItemId,
  onSelectLineItem,
  viewId,
  onViewChange,
}: ModuleScreenProps) {
  const navigate = useNavigate()
  const { canEdit, locked } = useStructureAccess(modelId)
  const { workspace } = useCurrentWorkspace()
  const updateModule = useUpdateModule(modelId)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { ref: settingsRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()

  return (
    <>
      <PageHeader
        title={module.name}
        renderTitle={(headingClassName, headingRef) => (
          <ModuleTitle
            name={module.name}
            headingClassName={headingClassName}
            headingRef={headingRef}
            locked={locked}
            onRename={
              canEdit
                ? async (name) => {
                    await updateModule.mutateAsync({ moduleId: module.id, body: { name } })
                    toast.success("Module renamed")
                  }
                : undefined
            }
          />
        )}
        description={
          <div className="flex flex-wrap items-center gap-1.5">
            {module.functional_area && (
              <span className="inline-flex items-center gap-1">
                <Folder className="size-3.5" />
                <span className="sr-only">Functional area: </span>
                {module.functional_area}
              </span>
            )}
            {module.axes.map((axis, index) => (
              <Badge key={index} variant="outline">
                {axisLabel(axis, structure)}
              </Badge>
            ))}
          </div>
        }
        actions={
          <>
            <LiveIndicator />
            {canEdit && (
              <ProductionLock locked={locked}>
                <Button
                  ref={settingsRef}
                  variant="outline"
                  disabled={locked}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings />
                  Module settings
                </Button>
              </ProductionLock>
            )}
          </>
        }
      />
      {locked && (
        <div className="mb-4">
          <ProductionNotice />
        </div>
      )}
      <Tabs value={tab} onValueChange={(value) => onTabChange(value as ModuleTab)}>
        <TabsList>
          <TabsTrigger value="grid">Grid</TabsTrigger>
          <TabsTrigger value="blueprint">Blueprint</TabsTrigger>
        </TabsList>
        <TabsContent value="grid" className="mt-2">
          <ModuleGrid
            modelId={modelId}
            module={module}
            structure={structure}
            readOnly={workspace === undefined || !canEditCells(workspace.role)}
            canEditFormulas={canEdit}
            canSaveViews={canEdit}
            locked={locked}
            viewId={viewId}
            onViewChange={onViewChange}
            onOpenBlueprint={() => onTabChange("blueprint")}
          />
        </TabsContent>
        <TabsContent value="blueprint" className="mt-2">
          <Blueprint
            modelId={modelId}
            module={module}
            structure={structure}
            selectedId={selectedLineItemId}
            onSelect={onSelectLineItem}
            canEdit={canEdit}
            locked={locked}
          />
        </TabsContent>
      </Tabs>
      {canEdit && (
        <ModuleSettingsSheet
          modelId={modelId}
          structure={structure}
          module={module}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          locked={locked}
          onDeleted={() => void navigate({ to: "/m/$modelId/modules", params: { modelId } })}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </>
  )
}
