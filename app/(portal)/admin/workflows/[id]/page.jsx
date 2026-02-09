"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import {
  IconArrowLeft,
  IconDeviceFloppy,
  IconGitBranch,
  IconLoader2,
  IconPlus,
  IconTrash,
  IconEdit,
  IconGripVertical,
  IconChevronRight,
  IconCheck,
  IconX,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { cn } from "@/lib/utils";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const WORKFLOW_CATEGORIES = [
  "Sales",
  "Support",
  "Onboarding",
  "Fulfillment",
  "Operations",
  "HR",
  "Other",
];

export default function WorkflowEditorPage() {
  const router = useRouter();
  const params = useParams();
  const workflowId = params.id;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [workflow, setWorkflow] = useState(null);
  const [stages, setStages] = useState([]);
  const [selectedStageId, setSelectedStageId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Edit states
  const [editingWorkflow, setEditingWorkflow] = useState(false);
  const [workflowForm, setWorkflowForm] = useState({
    name: "",
    description: "",
    category: "",
    is_active: false,
  });

  // New stage dialog
  const [showNewStageDialog, setShowNewStageDialog] = useState(false);
  const [newStageName, setNewStageName] = useState("");
  const [savingStage, setSavingStage] = useState(false);

  // New item dialog
  const [showNewItemDialog, setShowNewItemDialog] = useState(false);
  const [newItemForm, setNewItemForm] = useState({ label: "", description: "" });
  const [savingItem, setSavingItem] = useState(false);

  // Editing stage
  const [editingStageId, setEditingStageId] = useState(null);
  const [editingStageName, setEditingStageName] = useState("");

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Handle stage reorder via drag & drop
  async function handleStageReorder(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = stages.findIndex((s) => s.id === active.id);
    const newIndex = stages.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reorderedStages = arrayMove(stages, oldIndex, newIndex);
    setStages(reorderedStages);

    // Persist order to backend
    try {
      const updates = reorderedStages.map((s, idx) => ({
        id: s.id,
        order_index: idx,
      }));
      for (const update of updates) {
        await fetch(
          `/api/admin/workflows/${workflowId}/stages/${update.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order_index: update.order_index }),
          }
        );
      }
    } catch (err) {
      notify({
        title: "Reorder failed",
        description: String(err.message || err),
        variant: "error",
      });
      loadWorkflow();
    }
  }

  // Handle item reorder via drag & drop
  async function handleItemReorder(event) {
    const { active, over } = event;
    if (!over || active.id === over.id || !selectedStageId) return;

    const currentItems = stages.find((s) => s.id === selectedStageId)?.items || [];
    const oldIndex = currentItems.findIndex((i) => i.id === active.id);
    const newIndex = currentItems.findIndex((i) => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reorderedItems = arrayMove(currentItems, oldIndex, newIndex);

    // Update local state
    setStages(
      stages.map((s) =>
        s.id === selectedStageId ? { ...s, items: reorderedItems } : s
      )
    );

    // Persist order to backend
    try {
      const updates = reorderedItems.map((item, idx) => ({
        id: item.id,
        order_index: idx,
      }));
      for (const update of updates) {
        await fetch(
          `/api/admin/workflows/${workflowId}/items/${update.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order_index: update.order_index }),
          }
        );
      }
    } catch (err) {
      notify({
        title: "Reorder failed",
        description: String(err.message || err),
        variant: "error",
      });
      loadWorkflow();
    }
  }

  // Load workflow
  const loadWorkflow = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/workflows/${workflowId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load workflow");

      setWorkflow(data.workflow);
      setWorkflowForm({
        name: data.workflow.name,
        description: data.workflow.description || "",
        category: data.workflow.category || "",
        is_active: data.workflow.is_active,
      });
      const workflowStages = data.workflow.stages || data.stages || [];
      setStages(workflowStages);

      // Select first stage if none selected
      if (!selectedStageId && workflowStages.length > 0) {
        setSelectedStageId(workflowStages[0].id);
      }
    } catch (err) {
      notify({
        title: "Load failed",
        description: String(err.message || err),
        variant: "error",
      });
      router.push("/admin/workflows");
    } finally {
      setLoading(false);
    }
  }, [workflowId, selectedStageId, router]);

  useEffect(() => {
    loadWorkflow();
  }, [loadWorkflow]);

  // Get selected stage and its items
  const selectedStage = stages.find((s) => s.id === selectedStageId);
  const stageItems = selectedStage?.items || [];
  const selectedItem = stageItems.find((i) => i.id === selectedItemId);

  // Save workflow details
  async function saveWorkflow() {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/workflows/${workflowId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workflowForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to save workflow");

      setWorkflow(data.workflow);
      setEditingWorkflow(false);
      setHasChanges(false);
      notify({
        title: "Workflow saved",
        description: "Changes have been saved successfully.",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Save failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  // Add new stage
  async function addStage() {
    if (!newStageName.trim()) return;

    setSavingStage(true);
    try {
      const res = await fetch(`/api/admin/workflows/${workflowId}/stages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newStageName.trim(),
          sort_order: stages.length,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to create stage");

      // Add new stage to list with empty items array
      const newStage = { ...data.stage, items: [] };
      setStages([...stages, newStage]);
      setSelectedStageId(data.stage.id);
      setNewStageName("");
      setShowNewStageDialog(false);
      notify({
        title: "Stage created",
        description: "New stage has been added.",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Create failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSavingStage(false);
    }
  }

  // Update stage name
  async function updateStageName(stageId, name) {
    if (!name.trim()) return;

    try {
      const res = await fetch(
        `/api/admin/workflows/${workflowId}/stages/${stageId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to update stage");

      setStages(
        stages.map((s) =>
          s.id === stageId ? { ...s, name: name.trim() } : s
        )
      );
      setEditingStageId(null);
    } catch (err) {
      notify({
        title: "Update failed",
        description: String(err.message || err),
        variant: "error",
      });
    }
  }

  // Delete stage
  async function deleteStage(stageId) {
    try {
      const res = await fetch(
        `/api/admin/workflows/${workflowId}/stages/${stageId}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to delete stage");
      }

      const newStages = stages.filter((s) => s.id !== stageId);
      setStages(newStages);
      if (selectedStageId === stageId) {
        setSelectedStageId(newStages[0]?.id || null);
        setSelectedItemId(null);
      }
      notify({
        title: "Stage deleted",
        description: "Stage and its items have been deleted.",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Delete failed",
        description: String(err.message || err),
        variant: "error",
      });
    }
  }

  // Add new item
  async function addItem() {
    if (!newItemForm.label.trim() || !selectedStageId) return;

    setSavingItem(true);
    try {
      const res = await fetch(
        `/api/admin/workflows/${workflowId}/stages/${selectedStageId}/items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: newItemForm.label.trim(),
            description: newItemForm.description.trim(),
            sort_order: stageItems.length,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to create item");

      // Update stages with new item
      setStages(
        stages.map((s) =>
          s.id === selectedStageId
            ? { ...s, items: [...(s.items || []), data.item] }
            : s
        )
      );
      setSelectedItemId(data.item.id);
      setNewItemForm({ label: "", description: "" });
      setShowNewItemDialog(false);
      notify({
        title: "Item created",
        description: "New item has been added to the stage.",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Create failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSavingItem(false);
    }
  }

  // Update item
  async function updateItem(itemId, updates) {
    try {
      const res = await fetch(
        `/api/admin/workflows/${workflowId}/items/${itemId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to update item");

      // Update stages with updated item
      setStages(
        stages.map((s) =>
          s.id === selectedStageId
            ? {
                ...s,
                items: s.items.map((i) =>
                  i.id === itemId ? { ...i, ...updates } : i
                ),
              }
            : s
        )
      );
      notify({
        title: "Item updated",
        description: "Changes have been saved.",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Update failed",
        description: String(err.message || err),
        variant: "error",
      });
    }
  }

  // Delete item
  async function deleteItem(itemId) {
    try {
      const res = await fetch(
        `/api/admin/workflows/${workflowId}/items/${itemId}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to delete item");
      }

      // Update stages
      setStages(
        stages.map((s) =>
          s.id === selectedStageId
            ? { ...s, items: s.items.filter((i) => i.id !== itemId) }
            : s
        )
      );
      if (selectedItemId === itemId) {
        setSelectedItemId(null);
      }
      notify({
        title: "Item deleted",
        description: "Item has been deleted.",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Delete failed",
        description: String(err.message || err),
        variant: "error",
      });
    }
  }

  // Move stage (reorder)
  async function moveStage(stageId, direction) {
    const currentIndex = stages.findIndex((s) => s.id === stageId);
    if (currentIndex === -1) return;

    const newIndex =
      direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= stages.length) return;

    const newStages = [...stages];
    [newStages[currentIndex], newStages[newIndex]] = [
      newStages[newIndex],
      newStages[currentIndex],
    ];

    // Update sort_order for affected stages
    const updates = newStages.map((s, idx) => ({
      id: s.id,
      sort_order: idx,
    }));

    setStages(newStages);

    // Persist to backend
    try {
      for (const update of updates) {
        await fetch(
          `/api/admin/workflows/${workflowId}/stages/${update.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sort_order: update.sort_order }),
          }
        );
      }
    } catch (err) {
      notify({
        title: "Reorder failed",
        description: String(err.message || err),
        variant: "error",
      });
      loadWorkflow(); // Reload to get correct order
    }
  }

  if (loading) {
    return (
      <div className="px-4 lg:px-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-3">
            <Skeleton className="h-[600px]" />
          </div>
          <div className="col-span-5">
            <Skeleton className="h-[600px]" />
          </div>
          <div className="col-span-4">
            <Skeleton className="h-[600px]" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/admin/workflows")}
          >
            <IconArrowLeft className="size-4 mr-1" />
            Back
          </Button>
          <div className="flex items-center gap-2">
            <IconGitBranch className="size-5 text-telnyx-green" />
            <span className="text-lg font-semibold">{workflow?.name}</span>
            {workflow?.is_active ? (
              <Badge className="border-green-500 text-green-600" variant="outline">
                Active
              </Badge>
            ) : (
              <Badge className="border-gray-400 text-gray-500" variant="outline">
                Inactive
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditingWorkflow(true)}
          >
            <IconEdit className="size-4 mr-1" />
            Edit Details
          </Button>
        </div>
      </div>

      {/* Main Content - 3 Column Layout */}
      <div className="grid grid-cols-12 gap-4 h-[calc(100vh-180px)]">
        {/* Left Panel: Stages */}
        <div className="col-span-3">
          <Card className="h-full flex flex-col">
            <CardHeader className="py-3 px-4 border-b flex-shrink-0">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Stages</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowNewStageDialog(true)}
                >
                  <IconPlus className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-2 flex-1 overflow-auto">
              {stages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                  <p className="text-sm">No stages yet</p>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setShowNewStageDialog(true)}
                  >
                    Add your first stage
                  </Button>
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleStageReorder}
                >
                  <SortableContext
                    items={stages.map((s) => s.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-1">
                      {stages.map((stage) => (
                        <SortableStage
                          key={stage.id}
                          stage={stage}
                          isSelected={selectedStageId === stage.id}
                          isEditing={editingStageId === stage.id}
                          editingStageName={editingStageName}
                          setEditingStageName={setEditingStageName}
                          onSelect={() => {
                            setSelectedStageId(stage.id);
                            setSelectedItemId(null);
                          }}
                          onEdit={() => {
                            setEditingStageId(stage.id);
                            setEditingStageName(stage.name);
                          }}
                          onCancelEdit={() => setEditingStageId(null)}
                          onSaveName={() => updateStageName(stage.id, editingStageName)}
                          onDelete={() => deleteStage(stage.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Center Panel: Items */}
        <div className="col-span-5">
          <Card className="h-full flex flex-col">
            <CardHeader className="py-3 px-4 border-b flex-shrink-0">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">
                  {selectedStage ? `Items in "${selectedStage.name}"` : "Items"}
                </CardTitle>
                {selectedStageId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowNewItemDialog(true)}
                  >
                    <IconPlus className="size-4" />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-2 flex-1 overflow-auto">
              {!selectedStageId ? (
                <div className="flex items-center justify-center h-full text-center text-muted-foreground">
                  <p className="text-sm">Select a stage to view items</p>
                </div>
              ) : stageItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                  <p className="text-sm">No items in this stage</p>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setShowNewItemDialog(true)}
                  >
                    Add your first item
                  </Button>
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleItemReorder}
                >
                  <SortableContext
                    items={stageItems.map((i) => i.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-1">
                      {stageItems.map((item) => (
                        <SortableItem
                          key={item.id}
                          item={item}
                          isSelected={selectedItemId === item.id}
                          onSelect={() => setSelectedItemId(item.id)}
                          onDelete={() => deleteItem(item.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Panel: Item Editor */}
        <div className="col-span-4">
          <Card className="h-full flex flex-col">
            <CardHeader className="py-3 px-4 border-b flex-shrink-0">
              <CardTitle className="text-sm font-medium">
                {selectedItem ? "Edit Item" : "Item Details"}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 flex-1 overflow-auto">
              {!selectedItem ? (
                <div className="flex items-center justify-center h-full text-center text-muted-foreground">
                  <p className="text-sm">Select an item to edit</p>
                </div>
              ) : (
                <ItemEditor
                  item={selectedItem}
                  onSave={(updates) => updateItem(selectedItem.id, updates)}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Edit Workflow Dialog */}
      <Dialog open={editingWorkflow} onOpenChange={setEditingWorkflow}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Workflow</DialogTitle>
            <DialogDescription>
              Update the workflow name, description, and settings.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={workflowForm.name}
                onChange={(e) =>
                  setWorkflowForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={workflowForm.description}
                onChange={(e) =>
                  setWorkflowForm((f) => ({ ...f, description: e.target.value }))
                }
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-category">Category</Label>
              <Select
                value={workflowForm.category}
                onValueChange={(value) =>
                  setWorkflowForm((f) => ({ ...f, category: value }))
                }
              >
                <SelectTrigger id="edit-category">
                  <SelectValue placeholder="Select a category..." />
                </SelectTrigger>
                <SelectContent>
                  {WORKFLOW_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-active">Active</Label>
              <Switch
                id="edit-active"
                checked={workflowForm.is_active}
                onCheckedChange={(checked) =>
                  setWorkflowForm((f) => ({ ...f, is_active: checked }))
                }
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button
              variant="outline"
              onClick={() => setEditingWorkflow(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={saveWorkflow} disabled={saving}>
              {saving ? (
                <>
                  <IconLoader2 className="size-4 mr-1 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <IconDeviceFloppy className="size-4 mr-1" />
                  Save
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* New Stage Dialog */}
      <Dialog open={showNewStageDialog} onOpenChange={setShowNewStageDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Stage</DialogTitle>
            <DialogDescription>
              Create a new stage for this workflow.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="new-stage-name">Stage Name</Label>
              <Input
                id="new-stage-name"
                value={newStageName}
                onChange={(e) => setNewStageName(e.target.value)}
                placeholder="e.g., New Leads, In Progress, Completed"
                onKeyDown={(e) => {
                  if (e.key === "Enter") addStage();
                }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button
              variant="outline"
              onClick={() => {
                setShowNewStageDialog(false);
                setNewStageName("");
              }}
              disabled={savingStage}
            >
              Cancel
            </Button>
            <Button onClick={addStage} disabled={savingStage || !newStageName.trim()}>
              {savingStage ? (
                <>
                  <IconLoader2 className="size-4 mr-1 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Stage"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* New Item Dialog */}
      <Dialog open={showNewItemDialog} onOpenChange={setShowNewItemDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Item</DialogTitle>
            <DialogDescription>
              Create a new item in the "{selectedStage?.name}" stage.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="new-item-label">Item Label</Label>
              <Input
                id="new-item-label"
                value={newItemForm.label}
                onChange={(e) =>
                  setNewItemForm((f) => ({ ...f, label: e.target.value }))
                }
                placeholder="Enter item label..."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-item-description">Description (optional)</Label>
              <Textarea
                id="new-item-description"
                value={newItemForm.description}
                onChange={(e) =>
                  setNewItemForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Enter item description..."
                rows={3}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button
              variant="outline"
              onClick={() => {
                setShowNewItemDialog(false);
                setNewItemForm({ label: "", description: "" });
              }}
              disabled={savingItem}
            >
              Cancel
            </Button>
            <Button
              onClick={addItem}
              disabled={savingItem || !newItemForm.label.trim()}
            >
              {savingItem ? (
                <>
                  <IconLoader2 className="size-4 mr-1 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Item"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Item Editor Component
function ItemEditor({ item, onSave }) {
  const [form, setForm] = useState({
    label: item.label || "",
    description: item.description || "",
  });
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Reset form when item changes
  useEffect(() => {
    setForm({
      label: item.label || "",
      description: item.description || "",
    });
    setHasChanges(false);
  }, [item.id, item.label, item.description]);

  // Check for changes
  useEffect(() => {
    const changed =
      form.label !== (item.label || "") ||
      form.description !== (item.description || "");
    setHasChanges(changed);
  }, [form, item]);

  async function handleSave() {
    if (!form.label.trim()) {
      notify({
        title: "Validation Error",
        description: "Item label is required",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      await onSave({
        label: form.label.trim(),
        description: form.description.trim(),
      });
      setHasChanges(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="item-label">Label</Label>
        <Input
          id="item-label"
          value={form.label}
          onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="item-description">Description</Label>
        <Textarea
          id="item-description"
          value={form.description}
          onChange={(e) =>
            setForm((f) => ({ ...f, description: e.target.value }))
          }
          rows={4}
        />
      </div>
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving || !hasChanges}>
          {saving ? (
            <>
              <IconLoader2 className="size-4 mr-1 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <IconDeviceFloppy className="size-4 mr-1" />
              Save Changes
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// Sortable Stage Component
function SortableStage({
  stage,
  isSelected,
  isEditing,
  editingStageName,
  setEditingStageName,
  onSelect,
  onEdit,
  onCancelEdit,
  onSaveName,
  onDelete,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: stage.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors",
        isSelected
          ? "bg-telnyx-green/10 border border-telnyx-green"
          : "hover:bg-muted",
        isDragging && "shadow-lg"
      )}
      onClick={onSelect}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing touch-none"
        onClick={(e) => e.stopPropagation()}
      >
        <IconGripVertical className="size-4 text-muted-foreground flex-shrink-0" />
      </div>

      {isEditing ? (
        <div className="flex-1 flex items-center gap-1">
          <Input
            value={editingStageName}
            onChange={(e) => setEditingStageName(e.target.value)}
            className="h-7 text-sm"
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveName();
              else if (e.key === "Escape") onCancelEdit();
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={(e) => {
              e.stopPropagation();
              onSaveName();
            }}
          >
            <IconCheck className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={(e) => {
              e.stopPropagation();
              onCancelEdit();
            }}
          >
            <IconX className="size-3" />
          </Button>
        </div>
      ) : (
        <>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{stage.name}</div>
            <div className="text-xs text-muted-foreground">
              {stage.items?.length || 0} items
            </div>
          </div>
          <div className="hidden group-hover:flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              <IconEdit className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-red-500"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <IconTrash className="size-3" />
            </Button>
          </div>
          <IconChevronRight
            className={cn(
              "size-4 flex-shrink-0 transition-colors",
              isSelected ? "text-telnyx-green" : "text-muted-foreground"
            )}
          />
        </>
      )}
    </div>
  );
}

// Sortable Item Component
function SortableItem({ item, isSelected, onSelect, onDelete }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors",
        isSelected
          ? "bg-telnyx-green/10 border border-telnyx-green"
          : "hover:bg-muted",
        isDragging && "shadow-lg"
      )}
      onClick={onSelect}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing touch-none"
        onClick={(e) => e.stopPropagation()}
      >
        <IconGripVertical className="size-4 text-muted-foreground flex-shrink-0" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{item.label}</div>
        {item.description && (
          <div className="text-xs text-muted-foreground truncate">
            {item.description}
          </div>
        )}
      </div>
      <div className="hidden group-hover:flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-red-500"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <IconTrash className="size-3" />
        </Button>
      </div>
      <IconChevronRight
        className={cn(
          "size-4 flex-shrink-0 transition-colors",
          isSelected ? "text-telnyx-green" : "text-muted-foreground"
        )}
      />
    </div>
  );
}
