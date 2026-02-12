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
import { Combobox } from "@/components/ui/combobox";
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
  IconRobot,
  IconTestPipe2,
  IconRefresh,
} from "@tabler/icons-react";
import CreateAgentSheet from "@/components/workflows/CreateAgentSheet";
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
    llm_model: "openai/gpt-4o",
  });
  
  // LLM models
  const [llmModels, setLlmModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  
  // AI Agent
  const [showCreateAgentSheet, setShowCreateAgentSheet] = useState(false);
  const [updatingAssistant, setUpdatingAssistant] = useState(false);
  const [assistantExists, setAssistantExists] = useState(true);
  const [showUpdateConfirmDialog, setShowUpdateConfirmDialog] = useState(false);
  const [showDeleteAgentDialog, setShowDeleteAgentDialog] = useState(false);
  const [deletingAgent, setDeletingAgent] = useState(false);

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
        llm_model: data.workflow.llm_model || "openai/gpt-4o",
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

  // Verify assigned AI assistant still exists on Telnyx; clear from workflow if deleted
  useEffect(() => {
    if (!workflow?.ai_assistant_id) {
      setAssistantExists(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/ai/assistants/${workflow.ai_assistant_id}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          if (res.status === 404) {
            setAssistantExists(false);
            const putRes = await fetch(`/api/admin/workflows/${workflowId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ai_assistant_id: null }),
            });
            if (putRes.ok) {
              setWorkflow((prev) =>
                prev ? { ...prev, ai_assistant_id: null } : prev
              );
              notify({
                title: "AI Assistant Removed",
                description: "The assigned AI assistant was deleted on Telnyx. You can create a new one.",
                variant: "info",
              });
            }
          }
        } else {
          setAssistantExists(true);
        }
      } catch (err) {
        if (!cancelled) setAssistantExists(true);
      }
    })();
    return () => { cancelled = true; };
  }, [workflow?.ai_assistant_id, workflowId]);
  
  // Load available LLM models
  useEffect(() => {
    async function fetchModels() {
      setLoadingModels(true);
      try {
        const res = await fetch("/api/ai/models");
        const data = await res.json();
        if (data.ok && data.models) {
          setLlmModels(data.models);
        }
      } catch (err) {
        console.error("Failed to load models:", err);
      } finally {
        setLoadingModels(false);
      }
    }
    fetchModels();
  }, []);

  // Get selected stage and its items
  const selectedStage = stages.find((s) => s.id === selectedStageId);
  const stageItems = selectedStage?.items || [];
  const selectedItem = stageItems.find((i) => i.id === selectedItemId);

  // Update AI Agent handler
  async function handleUpdateAgent() {
    setUpdatingAssistant(true);
    setShowUpdateConfirmDialog(false);
    try {
      const res = await fetch(
        `/api/admin/workflows/${workflowId}/update-assistant`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update assistant");
      }
      notify({
        title: "AI Agent Updated",
        description: "Assistant instructions and insights have been synced with the current workflow.",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Update Failed",
        description: err.message || "Failed to update AI agent",
        variant: "error",
      });
    } finally {
      setUpdatingAssistant(false);
    }
  }

  // Delete AI Agent handler
  async function handleDeleteAgent() {
    setDeletingAgent(true);
    try {
      const res = await fetch(
        `/api/admin/workflows/${workflowId}/delete-assistant`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete assistant");
      }
      // Update local state
      setWorkflow((prev) => prev ? { 
        ...prev, 
        ai_assistant_id: null,
        insight_group_id: null,
        insight_slots_id: null,
        insight_summary_id: null,
        insight_sentiment_id: null,
      } : prev);
      setShowDeleteAgentDialog(false);
      notify({
        title: "AI Agent Deleted",
        description: "The AI assistant and all associated insights have been removed.",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Delete Failed",
        description: err.message || "Failed to delete AI agent",
        variant: "error",
      });
    } finally {
      setDeletingAgent(false);
    }
  }

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
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-[600px]" />
          <Skeleton className="h-[600px]" />
          <Skeleton className="h-[600px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 h-[calc(100vh-120px)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCreateAgentSheet(true)}
            disabled={!!workflow?.ai_assistant_id && assistantExists}
            title={
              workflow?.ai_assistant_id && assistantExists
                ? "AI Agent already created"
                : "Create AI Agent"
            }
          >
            <IconRobot className="size-4 mr-1" />
            Create AI Agent
          </Button>
          {workflow?.ai_assistant_id && assistantExists && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowUpdateConfirmDialog(true)}
                disabled={updatingAssistant}
                title="Sync assistant instructions with current workflow"
              >
                {updatingAssistant ? (
                  <IconLoader2 className="size-4 mr-1 animate-spin" />
                ) : (
                  <IconRefresh className="size-4 mr-1" />
                )}
                Update AI Agent
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDeleteAgentDialog(true)}
                disabled={deletingAgent}
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                title="Delete AI Agent and associated insights"
              >
                {deletingAgent ? (
                  <IconLoader2 className="size-4 mr-1 animate-spin" />
                ) : (
                  <IconTrash className="size-4 mr-1" />
                )}
                Delete AI Agent
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(`/admin/workflows/${workflowId}/test`)}
            disabled={!workflow?.ai_assistant_id || !assistantExists}
            title={
              !workflow?.ai_assistant_id || !assistantExists
                ? "Create an AI Agent first"
                : "Test AI Agent"
            }
          >
            <IconTestPipe2 className="size-4 mr-1" />
            Test AI Agent
          </Button>
        </div>
      </div>

      {/* Main Content - 3 Column Layout (equal widths) */}
      <div className="grid grid-cols-3 gap-4 flex-1 min-h-0">
        {/* Left Panel: Stages */}
        <div className="min-h-0 h-full">
          <Card className="h-full flex flex-col overflow-hidden">
            <CardHeader className="py-3 px-4 border-b flex-shrink-0 h-14">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <IconGitBranch className="size-4" />
                  Stages
                </CardTitle>
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
        <div className="min-h-0 h-full">
          <Card className="h-full flex flex-col overflow-hidden">
            <CardHeader className="py-3 px-4 border-b flex-shrink-0 h-14">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <IconCheck className="size-4" />
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
        <div className="min-h-0 h-full">
          <Card className="h-full flex flex-col overflow-hidden">
            <CardHeader className="py-3 px-4 border-b flex-shrink-0 h-14">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <IconEdit className="size-4" />
                {selectedItem ? "Edit Item" : "Item Details"}
              </CardTitle>
            </CardHeader>
            {!selectedItem ? (
              <CardContent className="flex-1 flex items-center justify-center text-center text-muted-foreground">
                <p className="text-sm">Select an item to edit</p>
              </CardContent>
            ) : (
              <div className="flex-1 min-h-0 overflow-hidden">
                <ItemEditor
                  item={selectedItem}
                  onSave={(updates) => updateItem(selectedItem.id, updates)}
                />
              </div>
            )}
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
            <div className="space-y-2">
              <Label htmlFor="edit-llm-model">LLM Model</Label>
              <Combobox
                value={workflowForm.llm_model}
                onChange={(value) =>
                  setWorkflowForm((f) => ({ ...f, llm_model: value }))
                }
                options={llmModels.map((model) => ({
                  value: model.id,
                  label: `${model.id} (${model.parameters} • ${model.tier})`,
                }))}
                placeholder={loadingModels ? "Loading models..." : "Select model..."}
                disabled={loadingModels}
                searchable={true}
                triggerClassName="w-full"
                contentClassName="w-[450px]"
              />
              <p className="text-xs text-muted-foreground">
                Model used for workflow analysis and suggestions
              </p>
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
      
      {/* Create AI Agent Sheet */}
      <CreateAgentSheet
        open={showCreateAgentSheet}
        onOpenChange={setShowCreateAgentSheet}
        workflow={workflow}
        stages={stages}
        onAgentCreated={(agentId) => {
          // Refresh workflow to get updated ai_assistant_id
          setWorkflow(prev => prev ? { ...prev, ai_assistant_id: agentId } : prev);
          notify({ title: "Success", description: "AI Agent created successfully!", variant: "success" });
        }}
      />

      {/* Update AI Agent Confirmation Dialog */}
      <Dialog open={showUpdateConfirmDialog} onOpenChange={setShowUpdateConfirmDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update AI Agent</DialogTitle>
            <DialogDescription>
              This will sync the AI assistant&apos;s instructions and insights with the current workflow configuration.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              The following will be updated:
            </p>
            <ul className="mt-2 space-y-1 text-sm list-disc list-inside">
              <li>Assistant instructions (from workflow stages)</li>
              <li>Insight templates (slot extraction, summary, sentiment)</li>
              <li>Insight group assignment</li>
            </ul>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setShowUpdateConfirmDialog(false)}
              disabled={updatingAssistant}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpdateAgent}
              disabled={updatingAssistant}
            >
              {updatingAssistant ? (
                <>
                  <IconLoader2 className="size-4 mr-1 animate-spin" />
                  Updating...
                </>
              ) : (
                <>
                  <IconRefresh className="size-4 mr-1" />
                  Update Agent
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete AI Agent Confirmation Dialog */}
      <Dialog open={showDeleteAgentDialog} onOpenChange={setShowDeleteAgentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-red-600">Delete AI Agent</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this AI agent? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              The following will be permanently deleted:
            </p>
            <ul className="mt-2 space-y-1 text-sm list-disc list-inside text-red-600">
              <li>AI Assistant on Telnyx</li>
              <li>Insight Group</li>
              <li>Insight Templates (slots, summary, sentiment)</li>
            </ul>
            <p className="mt-4 text-sm text-muted-foreground">
              The workflow definition will remain intact. You can create a new AI agent at any time.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setShowDeleteAgentDialog(false)}
              disabled={deletingAgent}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteAgent}
              disabled={deletingAgent}
            >
              {deletingAgent ? (
                <>
                  <IconLoader2 className="size-4 mr-1 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <IconTrash className="size-4 mr-1" />
                  Delete Agent
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const SLOT_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "select", label: "Select (options)" },
  { value: "boolean", label: "Yes/No" },
];

const ITEM_TYPES = [
  { value: "action", label: "Action", description: "Agent must perform this action" },
  { value: "question", label: "Question", description: "Agent must ask this question" },
  { value: "topic", label: "Topic", description: "Topic to cover in conversation" },
  { value: "slot", label: "Data Slot", description: "Data to collect from customer" },
];

const COMPLETION_TRIGGERS = [
  { value: "agent", label: "Agent", description: "Completed when agent addresses it" },
  { value: "customer", label: "Customer", description: "Completed when customer responds" },
  { value: "either", label: "Either", description: "Completed when either party addresses it" },
];

// Predefined hint colors for variety (border + text only, no background)
const HINT_COLORS = [
  { border: "border-blue-500", text: "text-blue-500" },
  { border: "border-green-500", text: "text-green-500" },
  { border: "border-purple-500", text: "text-purple-500" },
  { border: "border-orange-500", text: "text-orange-500" },
  { border: "border-pink-500", text: "text-pink-500" },
  { border: "border-cyan-500", text: "text-cyan-500" },
  { border: "border-amber-500", text: "text-amber-500" },
  { border: "border-indigo-500", text: "text-indigo-500" },
];

function getHintColor(index) {
  return HINT_COLORS[index % HINT_COLORS.length];
}

// Item Editor Component with all slot fields
function ItemEditor({ item, onSave }) {
  // Determine default completion_trigger based on type
  const getDefaultCompletionTrigger = (itemType) => {
    if (itemType === "slot") return "customer";
    return "agent";
  };

  const [form, setForm] = useState({
    label: item.label || "",
    description: item.description || "",
    type: item.type || "action",
    is_required: item.is_required !== false,
    slot_name: item.slot_name || "",
    slot_type: item.slot_type || "text",
    slot_options: item.slot_options || [],
    slot_validation: item.slot_validation || "",
    hints: item.hints || [],
    completion_trigger: item.completion_trigger || getDefaultCompletionTrigger(item.type || "action"),
  });
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [newOption, setNewOption] = useState("");
  const [newHint, setNewHint] = useState("");

  // Reset form when item changes
  useEffect(() => {
    const defaultTrigger = getDefaultCompletionTrigger(item.type || "action");
    setForm({
      label: item.label || "",
      description: item.description || "",
      type: item.type || "action",
      is_required: item.is_required !== false,
      slot_name: item.slot_name || "",
      slot_type: item.slot_type || "text",
      slot_options: Array.isArray(item.slot_options) ? item.slot_options : [],
      slot_validation: item.slot_validation || "",
      hints: Array.isArray(item.hints) ? item.hints : [],
      completion_trigger: item.completion_trigger || defaultTrigger,
    });
    setHasChanges(false);
    setNewOption("");
    setNewHint("");
  }, [item.id]);

  // Check for changes
  useEffect(() => {
    const originalOptions = Array.isArray(item.slot_options) ? item.slot_options : [];
    const originalHints = Array.isArray(item.hints) ? item.hints : [];
    const defaultTrigger = getDefaultCompletionTrigger(item.type || "action");
    const changed =
      form.label !== (item.label || "") ||
      form.description !== (item.description || "") ||
      form.type !== (item.type || "action") ||
      form.is_required !== (item.is_required !== false) ||
      form.slot_name !== (item.slot_name || "") ||
      form.slot_type !== (item.slot_type || "text") ||
      JSON.stringify(form.slot_options) !== JSON.stringify(originalOptions) ||
      form.slot_validation !== (item.slot_validation || "") ||
      JSON.stringify(form.hints) !== JSON.stringify(originalHints) ||
      form.completion_trigger !== (item.completion_trigger || defaultTrigger);
    setHasChanges(changed);
  }, [form, item]);

  function addOption() {
    if (!newOption.trim()) return;
    if (form.slot_options.includes(newOption.trim())) {
      notify({
        title: "Duplicate option",
        description: "This option already exists",
        variant: "error",
      });
      return;
    }
    setForm((f) => ({
      ...f,
      slot_options: [...f.slot_options, newOption.trim()],
    }));
    setNewOption("");
  }

  function removeOption(optionToRemove) {
    setForm((f) => ({
      ...f,
      slot_options: f.slot_options.filter((opt) => opt !== optionToRemove),
    }));
  }

  function addHint() {
    if (!newHint.trim()) return;
    if (form.hints.includes(newHint.trim())) {
      notify({
        title: "Duplicate hint",
        description: "This hint already exists",
        variant: "error",
      });
      return;
    }
    setForm((f) => ({
      ...f,
      hints: [...f.hints, newHint.trim()],
    }));
    setNewHint("");
  }

  function removeHint(hintToRemove) {
    setForm((f) => ({
      ...f,
      hints: f.hints.filter((h) => h !== hintToRemove),
    }));
  }

  async function handleSave() {
    if (!form.label.trim()) {
      notify({
        title: "Validation Error",
        description: "Item label is required",
        variant: "error",
      });
      return;
    }

    // Validate slot fields for slot type
    if (form.type === "slot" && !form.slot_name.trim()) {
      notify({
        title: "Validation Error",
        description: "Slot name is required for data slot items",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      await onSave({
        label: form.label.trim(),
        description: form.description.trim(),
        type: form.type,
        is_required: form.is_required,
        completion_trigger: form.completion_trigger,
        slot_name: form.type === "slot" ? form.slot_name.trim() : null,
        slot_type: form.type === "slot" ? form.slot_type : null,
        slot_options: form.type === "slot" && form.slot_type === "select" ? form.slot_options : null,
        slot_validation: form.type === "slot" ? form.slot_validation.trim() : null,
        hints: form.hints.length > 0 ? form.hints : null,
      });
      setHasChanges(false);
    } finally {
      setSaving(false);
    }
  }

  const isSlotType = form.type === "slot";
  const showOptions = isSlotType && form.slot_type === "select";

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable form content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
      {/* Basic Info Section */}
      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Basic Info
        </h4>
        
        <div className="space-y-2">
          <Label htmlFor="item-type">Type</Label>
          <Select
            value={form.type}
            onValueChange={(value) => setForm((f) => ({ ...f, type: value }))}
          >
            <SelectTrigger id="item-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ITEM_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  <div className="flex flex-col">
                    <span>{t.label}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {ITEM_TYPES.find((t) => t.value === form.type)?.description}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="item-label">Label</Label>
          <Input
            id="item-label"
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            placeholder="e.g., Verify customer identity"
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
            placeholder="Additional context for the agent..."
            rows={2}
          />
        </div>

        <div className="flex items-center justify-between py-2">
          <div className="space-y-0.5">
            <Label htmlFor="item-required">Required</Label>
            <p className="text-xs text-muted-foreground">
              Agent must complete this item
            </p>
          </div>
          <Switch
            id="item-required"
            checked={form.is_required}
            onCheckedChange={(checked) =>
              setForm((f) => ({ ...f, is_required: checked }))
            }
          />
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="completion-trigger">Completion Trigger</Label>
          <Select
            value={form.completion_trigger}
            onValueChange={(value) =>
              setForm((f) => ({ ...f, completion_trigger: value }))
            }
          >
            <SelectTrigger id="completion-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPLETION_TRIGGERS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  <div className="flex flex-col">
                    <span>{t.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {t.description}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Who needs to speak for this item to be marked complete
          </p>
        </div>
      </div>

      {/* Prompt Hints Section */}
      <div className="space-y-4 border-t pt-4">
        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Prompt Hints
        </h4>
        <p className="text-xs text-muted-foreground -mt-2">
          Keywords or phrases to help AI detect when this item is completed
        </p>

        {/* Current hints as colored badges */}
        {form.hints.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {form.hints.map((hint, index) => {
              const color = getHintColor(index);
              return (
                <Badge
                  key={hint}
                  variant="outline"
                  className={cn(
                    "flex items-center gap-1 pr-1 border-2",
                    color.border,
                    color.text
                  )}
                >
                  {hint}
                  <button
                    type="button"
                    onClick={() => removeHint(hint)}
                    className={cn(
                      "ml-1 rounded-full p-0.5 transition-colors hover:bg-destructive hover:text-destructive-foreground",
                      color.text
                    )}
                  >
                    <IconX className="size-3" />
                  </button>
                </Badge>
              );
            })}
          </div>
        )}

        {/* Add new hint */}
        <div className="flex items-center gap-2">
          <Input
            value={newHint}
            onChange={(e) => setNewHint(e.target.value)}
            placeholder="Add a hint..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addHint();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addHint}
            disabled={!newHint.trim()}
          >
            <IconPlus className="size-4" />
          </Button>
        </div>
      </div>

      {/* Slot Configuration Section - Only visible when type is "slot" */}
      {isSlotType && (
        <div className="space-y-4 border-t pt-4">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Slot Configuration
          </h4>

          <div className="space-y-2">
            <Label htmlFor="slot-name">Slot Name</Label>
            <Input
              id="slot-name"
              value={form.slot_name}
              onChange={(e) =>
                setForm((f) => ({ ...f, slot_name: e.target.value }))
              }
              placeholder="e.g., customer_name, account_number"
            />
            <p className="text-xs text-muted-foreground">
              Identifier used to store the collected value (use snake_case)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="slot-type">Data Type</Label>
            <Select
              value={form.slot_type}
              onValueChange={(value) =>
                setForm((f) => ({ ...f, slot_type: value }))
              }
            >
              <SelectTrigger id="slot-type">
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
        </div>
      )}

      {/* Options Section - Only visible when slot_type is "select" */}
      {showOptions && (
        <div className="space-y-4 border-t pt-4">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Options
          </h4>
          <p className="text-xs text-muted-foreground -mt-2">
            Customer must choose one of these options
          </p>

          {/* Current options as colored badges */}
          {form.slot_options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {form.slot_options.map((opt, index) => {
                const color = getHintColor(index);
                return (
                  <Badge
                    key={opt}
                    variant="outline"
                    className={cn(
                      "flex items-center gap-1 pr-1 border-2",
                      color.border,
                      color.text
                    )}
                  >
                    {opt}
                    <button
                      type="button"
                      onClick={() => removeOption(opt)}
                      className={cn(
                        "ml-1 rounded-full p-0.5 transition-colors hover:bg-destructive hover:text-destructive-foreground",
                        color.text
                      )}
                    >
                      <IconX className="size-3" />
                    </button>
                  </Badge>
                );
              })}
            </div>
          )}

          {/* Add new option */}
          <div className="flex items-center gap-2">
            <Input
              value={newOption}
              onChange={(e) => setNewOption(e.target.value)}
              placeholder="Add an option..."
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addOption();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addOption}
              disabled={!newOption.trim()}
            >
              <IconPlus className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Validation Section - Only visible when type is "slot" */}
      {isSlotType && (
        <div className="space-y-4 border-t pt-4">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Validation Instructions
          </h4>

          <div className="space-y-2">
            <Textarea
              id="slot-validation"
              value={form.slot_validation}
              onChange={(e) =>
                setForm((f) => ({ ...f, slot_validation: e.target.value }))
              }
              placeholder="Instructions for the AI on how to validate/format this data.&#10;&#10;Examples:&#10;- Format as MM/DD/YYYY&#10;- Must be a valid US phone number (+1...)&#10;- Accept full name with at least first and last name"
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              LLM instructions for validating and formatting the captured value
            </p>
          </div>
        </div>
      )}

      </div>

      {/* Save Button - Fixed at bottom */}
      <div className="flex-shrink-0 p-4 border-t bg-background">
        <Button onClick={handleSave} disabled={saving || !hasChanges} className="w-full">
          {saving ? (
            <>
              <IconLoader2 className="size-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <IconDeviceFloppy className="size-4 mr-2" />
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
