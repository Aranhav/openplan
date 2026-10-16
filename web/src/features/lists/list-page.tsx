import { Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, ListTree, Settings } from "lucide-react"
import { useState } from "react"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { ProductionLock, ProductionNotice } from "@/components/production-lock"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useStructure } from "@/features/structure/api"
import type { StructureDto } from "@/features/structure/types"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { useStructureAccess } from "@/hooks/use-structure-access"
import { ItemsTab } from "./items-tab"
import { ListSettingsSheet } from "./list-settings-sheet"
import { PropertiesTab } from "./properties-tab"
import type { ListDto } from "./types"

type ListTab = "items" | "properties"

interface ListPageProps {
  modelId: string
  listId: string
  tab: ListTab
  onTabChange: (tab: ListTab) => void
}

export function ListPage({ modelId, listId, ...rest }: ListPageProps) {
  const structure = useStructure(modelId)
  const list = structure.data?.lists.find((candidate) => candidate.id === listId)

  if (list && structure.data) {
    // Keyed by the list, so that what was typed or chosen on another list does not follow here.
    return (
      <ListScreen
        key={list.id}
        modelId={modelId}
        list={list}
        structure={structure.data}
        {...rest}
      />
    )
  }
  if (structure.data && !structure.isFetching) {
    return <ListNotFound modelId={modelId} />
  }
  if (structure.isError) {
    return (
      <>
        <PageHeader title="List" />
        <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
      </>
    )
  }
  // The structure is on its way, or the list just left it and the page is about to leave too.
  return (
    <>
      <PageHeader title="List" />
      <div role="status" aria-label="Loading list" className="rounded-lg border">
        <div className="flex flex-col gap-4 p-4">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex items-center gap-4">
              <Skeleton className="size-4" />
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 flex-1" />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function ListNotFound({ modelId }: { modelId: string }) {
  useDocumentTitle("List not found · OpenPlan")
  return (
    <EmptyState
      icon={ListTree}
      title="List not found"
      description="It may have been deleted."
      action={
        <Button asChild>
          <Link to="/m/$modelId/lists" params={{ modelId }}>
            <ArrowLeft />
            Back to lists
          </Link>
        </Button>
      }
      headingLevel={1}
    />
  )
}

interface ListScreenProps extends Omit<ListPageProps, "listId"> {
  list: ListDto
  structure: StructureDto
}

function ListScreen({ modelId, list, structure, tab, onTabChange }: ListScreenProps) {
  const navigate = useNavigate()
  const { canEdit, locked } = useStructureAccess(modelId)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { ref: settingsRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const parentList = list.parent
    ? structure.lists.find((other) => other.id === list.parent)
    : undefined

  return (
    <>
      <PageHeader
        title={list.name}
        description={
          (parentList || list.numbered || list.production_data) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {parentList && (
                <Badge variant="outline" asChild>
                  <Link to="/m/$modelId/lists/$listId" params={{ modelId, listId: parentList.id }}>
                    Parent list: {parentList.name}
                  </Link>
                </Badge>
              )}
              {list.numbered && <Badge variant="secondary">Numbered</Badge>}
              {list.production_data && <Badge variant="outline">Production data</Badge>}
            </div>
          )
        }
        actions={
          canEdit && (
            <ProductionLock locked={locked}>
              <Button
                ref={settingsRef}
                variant="outline"
                disabled={locked}
                onClick={() => setSettingsOpen(true)}
              >
                <Settings />
                List settings
              </Button>
            </ProductionLock>
          )
        }
      />
      {locked && (
        <div className="mb-4">
          <ProductionNotice />
        </div>
      )}
      <Tabs value={tab} onValueChange={(value) => onTabChange(value as ListTab)}>
        <TabsList>
          <TabsTrigger value="items">Items</TabsTrigger>
          <TabsTrigger value="properties">Properties</TabsTrigger>
        </TabsList>
        <TabsContent value="items" className="mt-2">
          <ItemsTab
            modelId={modelId}
            list={list}
            structure={structure}
            canEdit={canEdit}
            locked={locked}
          />
        </TabsContent>
        <TabsContent value="properties" className="mt-2">
          <PropertiesTab
            modelId={modelId}
            list={list}
            structure={structure}
            canEdit={canEdit}
            locked={locked}
          />
        </TabsContent>
      </Tabs>
      {canEdit && (
        <ListSettingsSheet
          modelId={modelId}
          list={list}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          locked={locked}
          onDeleted={() => void navigate({ to: "/m/$modelId/lists", params: { modelId } })}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </>
  )
}
