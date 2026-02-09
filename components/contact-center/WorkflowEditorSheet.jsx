"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
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

const WORKFLOW_CATEGORIES = [
  "sales",
  "support",
  "healthcare",
  "survey",
  "onboarding",
  "operations",
  "other",
];

const ITEM_TYPES = [
  { value: "action", label: "Action", description: "Agent must perform this action" },
  { value: "question", label: "Question", description: "Agent must ask this question" },
  { value: "slot", label: "Slot", description: "Capture specific information" },
  { value: "topic", label: "Topic", description: "Discussion topic or theme" },
];

const SLOT_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "boolean", label: "Yes/No" },
];

export default function WorkflowEditorSheet({
  open,
  onOpenChange,
  workflowId,
  onBack,
  isNew = false,
}) {
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [workflow, setWorkflow] = useState(null);
  const [stages, setStages] = useState([]);
  const [selectedStageId, setSelectedStageId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);

  // Workflow form
  const [workflowForm, setWorkflowForm] = useState({
    name: "",
    description: "",
    category: "",
    is_active: true,
  });

  // New stage dialog
  const [showNewStageDialog, setShowNewStageDialog] = useState(false);
  const [newStageName, setNewStageName] = useState("");
  const [savingStage, setSavingStage] = useState(false);

  // New item dialog
  const [showNewItemDialog, setShowNewItemDialog] = useState(false);
  const [newItemForm, setNewItemForm] = useState({
    type: "action",
    label: "",
    prompt_hint: "",
    slot_name: "",
    slot_type: "text",
  });
  const [savingItem, setSavingItem] = useState(false);

  // Editing stage name inline
  const [editingStageId, setEditingStageId] = useState(null);
  const [editingStageName, setEditingStageName] = useState("");

  // Load workflow
  const loadWorkflow = useCallback(async () => {
    if (!workflowId || isNew) return;

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
      setStages(data.stages || []);

      if (data.stages?.length > 0) {
        setSelectedStageId(data.stages[0].id);
      }
    } catch (err) {
      notify({
        title: "Load failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [workflowId, isNew]);

  useEffect(() => {
    if (open && workflowId && !isNew) {
      setLoading(true);
      loadWorkflow();
    } else if (open && isNew) {
      // Reset for new workflow
      setWorkflow(null);
      setStages([]);
      setSelectedStageId(null);
      setSelectedItemId(null);
      setWorkflowForm({
        name: "",
        description: "",
        category: "",
        is_active: true,
      });
      setLoading(false);
    }
  }, [open, workflowId, isNew, loadWorkflow]);

  // Get selected stage and its items
  const selectedStage = stages.find((s) => s.id === selectedStageId);
  const stageItems = selectedStage?.items || [];
  const selectedItem = stageItems.find((i) => i.id === selectedItemId);

  // Create new workflow
  async function createWorkflow() {
    if (!workflowForm.name.trim()) {
      notify({
        title: "Validation Error",
        description: "Workflow name is required",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/admin/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workflowForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to create workflow");

      setWorkflow(data.workflow);
      notify({
        title: "Workflow created",
        description: "You can now add stages and items.",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Create failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  // Save workflow details
  async function saveWorkflow() {
    if (!workflow?.id) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/admin/workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workflowForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to save workflow");

      setWorkflow(data.workflow);
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
    if (!newStageName.trim() || !workflow?.id) return;

    setSavingStage(true);
    try {
      const res = await fetch(`/api/admin/workflows/${workflow.id}/stages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newStageName.trim(),
          order_index: stages.length,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to create stage");

      const newStage = { ...data.stage, items: [] };
      setStages([...stages, newStage]);
      setSelectedStageId(data.stage.id);
      setNewStageName("");
      setShowNewStageDialog(false);
      notify({
        title: "Stage created",
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
        `/api/admin/workflows/${workflow.id}/stages/${stageId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        }
      );
      if (!res.ok) throw new Error("Failed to update stage");

      setStages(stages.map((s) => (s.id === stageId ? { ...s, name: name.trim() } : s)));
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
        `/api/admin/workflows/${workflow.id}/stages/${stageId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("Failed to delete stage");

      const newStages = stages.filter((s) => s.id !== stageId);
      setStages(newStages);
      if (selectedStageId === stageId) {
        setSelectedStageId(newStages[0]?.id || null);
        setSelectedItemId(null);
      }
      notify({ title: "Stage deleted", variant: "success" });
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
        `/api/admin/workflows/${workflow.id}/stages/${selectedStageId}/items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: newItemForm.type,
            label: newItemForm.label.trim(),
            prompt_hint: newItemForm.prompt_hint.trim(),
            order_index: stageItems.length,
            slot_name: newItemForm.type === "slot" ? newItemForm.slot_name.trim() : null,
            slot_type: newItemForm.type === "slot" ? newItemForm.slot_type : null,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to create item");

      setStages(
        stages.map((s) =>
          s.id === selectedStageId
            ? { ...s, items: [...(s.items || []), data.item] }
            : s
        )
      );
      setSelectedItemId(data.item.id);
      setNewItemForm({
        type: "action",
        label: "",
        prompt_hint: "",
        slot_name: "",
        slot_type: "text",
      });
      setShowNewItemDialog(false);
      notify({ title: "Item created", variant: "success" });
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
        `/api/admin/workflows/${workflow.id}/items/${itemId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        }
      );
      if (!res.ok) throw new Error("Failed to update item");

      setStages(
        stages.map((s) =>
          s.id === selectedStageId
            ? {
                ...s,
                items: s.items.map((i) => (i.id === itemId ? { ...i, ...updates } : i)),
              }
            : s
        )
      );
      notify({ title: "Item updated", variant: "success" });
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
        `/api/admin/workflows/${workflow.id}/items/${itemId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("Failed to delete item");

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
      notify({ title: "Item deleted", variant: "success" });
    } catch (err) {
      notify({
        title: "Delete failed",
        description: String(err.message || err),
        variant: "error",
      });
    }
  }

  // Render new workflow form
  if (isNew && !workflow) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
          <SheetHeader className="px-6 py-4 border-b">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onBack} className="mr-2">
                <IconArrowLeft className="size-4" />
              </Button>
              <SheetTitle className="flex items-center gap-2">
                <IconGitBranch className="h-5 w-5 text-telnyx-green" />
                New Workflow
              </SheetTitle>
            </div>
          </SheetHeader>

          <div className="flex-1 p-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-name">Name *</Label>
              <Input
                id="new-name"
                value={workflowForm.name}
                onChange={(e) => setWorkflowForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g., Customer Support Call"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-description">Description</Label>
              <Textarea
                id="new-description"
                value={workflowForm.description}
                onChange={(e) =>
                  setWorkflowForm((f) => ({ ...f, description: e.target.value }))
                }
                rows={3}
                placeholder="Describe the purpose of this workflow..."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-category">Category</Label>
              <Select
                value={workflowForm.category}
                onValueChange={(value) =>
                  setWorkflowForm((f) => ({ ...f, category: value }))
                }
              >
                <SelectTrigger id="new-category">
                  <SelectValue placeholder="Select a category..." />
                </SelectTrigger>
                <SelectContent>
                  {WORKFLOW_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="new-active">Active</Label>
              <Switch
                id="new-active"
                checked={workflowForm.is_active}
                onCheckedChange={(checked) =>
                  setWorkflowForm((f) => ({ ...f, is_active: checked }))
                }
              />
            </div>
          </div>

          <SheetFooter className="px-6 py-4 border-t flex gap-2">
            <Button variant="outline" onClick={onBack}>
              Cancel
            </Button>
            <Button onClick={createWorkflow} disabled={saving || !workflowForm.name.trim()}>
              {saving ? (
                <>
                  <IconLoader2 className="size-4 mr-1 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Workflow"
              )}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );
  }

  // Loading state
  if (loading) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-4xl flex flex-col p-0">
          <SheetHeader className="px-6 py-4 border-b">
            <Skeleton className="h-6 w-48" />
          </SheetHeader>
          <div className="flex-1 p-6 grid grid-cols-3 gap-4">
            <Skeleton className="h-full" />
            <Skeleton className="h-full" />
            <Skeleton className="h-full" />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-4xl flex flex-col p-0">
        {/* Header */}
        <SheetHeader className="px-6 py-4 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onBack} className="mr-2">
                <IconArrowLeft className="size-4" />
              </Button>
              <IconGitBranch className="size-5 text-telnyx-green" />
              <Input
                value={workflowForm.name}
                onChange={(e) => setWorkflowForm((f) => ({ ...f, name: e.target.value }))}
                className="h-8 text-base font-semibold border-none bg-transparent hover:bg-muted focus:bg-background w-[200px]"
              />
              <Badge
                variant="outline"
                className={
                  workflowForm.is_active
                    ? "border-green-500 text-green-600"
                    : "border-gray-400 text-gray-500"
                }
              >
                {workflowForm.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={workflowForm.is_active}
                onCheckedChange={(checked) =>
                  setWorkflowForm((f) => ({ ...f, is_active: checked }))
                }
              />
              <Button size="sm" onClick={saveWorkflow} disabled={saving}>
                {saving ? (
                  <IconLoader2 className="size-4 animate-spin" />
                ) : (
                  <IconDeviceFloppy className="size-4" />
                )}
              </Button>
            </div>
          </div>
        </SheetHeader>

        {/* 3-Column Layout */}
        <div className="flex-1 grid grid-cols-3 gap-0 min-h-0">
          {/* Left: Stages */}
          <div className="border-r flex flex-col min-h-0">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <span className="text-sm font-medium">Stages</span>
              <Button variant="ghost" size="sm" onClick={() => setShowNewStageDialog(true)}>
                <IconPlus className="size-4" />
              </Button>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {stages.length === 0 ? (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    <p>No stages</p>
                    <Button variant="link" size="sm" onClick={() => setShowNewStageDialog(true)}>
                      Add first stage
                    </Button>
                  </div>
                ) : (
                  stages.map((stage) => (
                    <div
                      key={stage.id}
                      className={cn(
                        "group flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors",
                        selectedStageId === stage.id
                          ? "bg-telnyx-green/10 border border-telnyx-green"
                          : "hover:bg-muted"
                      )}
                      onClick={() => {
                        setSelectedStageId(stage.id);
                        setSelectedItemId(null);
                      }}
                    >
                      <IconGripVertical className="size-4 text-muted-foreground flex-shrink-0" />

                      {editingStageId === stage.id ? (
                        <div className="flex-1 flex items-center gap-1">
                          <Input
                            value={editingStageName}
                            onChange={(e) => setEditingStageName(e.target.value)}
                            className="h-7 text-sm"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") updateStageName(stage.id, editingStageName);
                              else if (e.key === "Escape") setEditingStageId(null);
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateStageName(stage.id, editingStageName);
                            }}
                          >
                            <IconCheck className="size-3" />
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
                                setEditingStageId(stage.id);
                                setEditingStageName(stage.name);
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
                                deleteStage(stage.id);
                              }}
                            >
                              <IconTrash className="size-3" />
                            </Button>
                          </div>
                          <IconChevronRight
                            className={cn(
                              "size-4 flex-shrink-0",
                              selectedStageId === stage.id
                                ? "text-telnyx-green"
                                : "text-muted-foreground"
                            )}
                          />
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Center: Items */}
          <div className="border-r flex flex-col min-h-0">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <span className="text-sm font-medium truncate">
                {selectedStage ? selectedStage.name : "Items"}
              </span>
              {selectedStageId && (
                <Button variant="ghost" size="sm" onClick={() => setShowNewItemDialog(true)}>
                  <IconPlus className="size-4" />
                </Button>
              )}
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {!selectedStageId ? (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    Select a stage
                  </div>
                ) : stageItems.length === 0 ? (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    <p>No items</p>
                    <Button variant="link" size="sm" onClick={() => setShowNewItemDialog(true)}>
                      Add first item
                    </Button>
                  </div>
                ) : (
                  stageItems.map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        "group flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors",
                        selectedItemId === item.id
                          ? "bg-telnyx-green/10 border border-telnyx-green"
                          : "hover:bg-muted"
                      )}
                      onClick={() => setSelectedItemId(item.id)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-xs">
                            {item.type}
                          </Badge>
                          <span className="text-sm truncate">{item.label}</span>
                        </div>
                        {item.prompt_hint && (
                          <div className="text-xs text-muted-foreground truncate mt-0.5">
                            {item.prompt_hint}
                          </div>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-red-500"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteItem(item.id);
                        }}
                      >
                        <IconTrash className="size-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Right: Item Editor */}
          <div className="flex flex-col min-h-0">
            <div className="px-4 py-3 border-b">
              <span className="text-sm font-medium">
                {selectedItem ? "Edit Item" : "Item Details"}
              </span>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-4">
                {!selectedItem ? (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    Select an item to edit
                  </div>
                ) : (
                  <ItemEditor item={selectedItem} onSave={(updates) => updateItem(selectedItem.id, updates)} />
                )}
              </div>
            </ScrollArea>
          </div>
        </div>

        {/* New Stage Dialog */}
        <Dialog open={showNewStageDialog} onOpenChange={setShowNewStageDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Stage</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>Stage Name</Label>
                <Input
                  value={newStageName}
                  onChange={(e) => setNewStageName(e.target.value)}
                  placeholder="e.g., Opening, Verification, Closing"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addStage();
                  }}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setShowNewStageDialog(false)}>
                Cancel
              </Button>
              <Button onClick={addStage} disabled={savingStage || !newStageName.trim()}>
                {savingStage ? <IconLoader2 className="size-4 animate-spin" /> : "Create"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* New Item Dialog */}
        <Dialog open={showNewItemDialog} onOpenChange={setShowNewItemDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Item</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={newItemForm.type}
                  onValueChange={(value) => setNewItemForm((f) => ({ ...f, type: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ITEM_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Label *</Label>
                <Input
                  value={newItemForm.label}
                  onChange={(e) => setNewItemForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="e.g., Ask for customer name"
                />
              </div>
              <div className="space-y-2">
                <Label>Prompt Hints</Label>
                <Input
                  value={newItemForm.prompt_hint}
                  onChange={(e) => setNewItemForm((f) => ({ ...f, prompt_hint: e.target.value }))}
                  placeholder="Keywords to detect, comma-separated"
                />
              </div>
              {newItemForm.type === "slot" && (
                <>
                  <div className="space-y-2">
                    <Label>Slot Name *</Label>
                    <Input
                      value={newItemForm.slot_name}
                      onChange={(e) => setNewItemForm((f) => ({ ...f, slot_name: e.target.value }))}
                      placeholder="e.g., customer_name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Slot Type</Label>
                    <Select
                      value={newItemForm.slot_type}
                      onValueChange={(value) => setNewItemForm((f) => ({ ...f, slot_type: value }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SLOT_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setShowNewItemDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={addItem}
                disabled={
                  savingItem ||
                  !newItemForm.label.trim() ||
                  (newItemForm.type === "slot" && !newItemForm.slot_name.trim())
                }
              >
                {savingItem ? <IconLoader2 className="size-4 animate-spin" /> : "Create"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

// Item Editor Component
function ItemEditor({ item, onSave }) {
  const [form, setForm] = useState({
    type: item.type,
    label: item.label,
    prompt_hint: item.prompt_hint || "",
    slot_name: item.slot_name || "",
    slot_type: item.slot_type || "text",
  });
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    setForm({
      type: item.type,
      label: item.label,
      prompt_hint: item.prompt_hint || "",
      slot_name: item.slot_name || "",
      slot_type: item.slot_type || "text",
    });
    setHasChanges(false);
  }, [item.id]);

  useEffect(() => {
    const changed =
      form.type !== item.type ||
      form.label !== item.label ||
      form.prompt_hint !== (item.prompt_hint || "") ||
      form.slot_name !== (item.slot_name || "") ||
      form.slot_type !== (item.slot_type || "text");
    setHasChanges(changed);
  }, [form, item]);

  async function handleSave() {
    if (!form.label.trim()) return;
    setSaving(true);
    try {
      await onSave({
        type: form.type,
        label: form.label.trim(),
        prompt_hint: form.prompt_hint.trim(),
        slot_name: form.type === "slot" ? form.slot_name.trim() : null,
        slot_type: form.type === "slot" ? form.slot_type : null,
      });
      setHasChanges(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Type</Label>
        <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ITEM_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Label</Label>
        <Input
          value={form.label}
          onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
        />
      </div>
      <div className="space-y-2">
        <Label>Prompt Hints</Label>
        <Textarea
          value={form.prompt_hint}
          onChange={(e) => setForm((f) => ({ ...f, prompt_hint: e.target.value }))}
          rows={3}
          placeholder="Keywords for detection..."
        />
      </div>
      {form.type === "slot" && (
        <>
          <div className="space-y-2">
            <Label>Slot Name</Label>
            <Input
              value={form.slot_name}
              onChange={(e) => setForm((f) => ({ ...f, slot_name: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Slot Type</Label>
            <Select
              value={form.slot_type}
              onValueChange={(v) => setForm((f) => ({ ...f, slot_type: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SLOT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}
      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={saving || !hasChanges}>
          {saving ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : (
            <>
              <IconDeviceFloppy className="size-4 mr-1" />
              Save
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
