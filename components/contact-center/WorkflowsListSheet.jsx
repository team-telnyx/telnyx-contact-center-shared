"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconGitBranch,
  IconEdit,
  IconTrash,
  IconCopy,
  IconPlus,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { notify } from "@/components/ToastNotify";

export default function WorkflowsListSheet({
  open,
  onOpenChange,
  onEditWorkflow,
  onNewWorkflow,
}) {
  const [items, setItems] = useState([]);
  const [filters, setFilters] = useState({
    active: "all",
    category: "all",
    q: "",
  });
  const [loading, setLoading] = useState(false);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", "1");
    sp.set("pageSize", "100");
    if (filters.active && filters.active !== "all")
      sp.set("active", filters.active);
    if (filters.category && filters.category !== "all")
      sp.set("category", filters.category);
    if (filters.q) sp.set("q", filters.q);
    return sp.toString();
  }, [filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/workflows?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch workflows");
      setItems(data.items || []);
    } catch (err) {
      notify({
        title: "Load failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      load();
    }
  }, [open, query]);

  async function onDelete(id) {
    if (!id) return;
    const r = await fetch(`/api/admin/workflows/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (r.ok) {
      notify({
        title: "Workflow deleted",
        description: "The workflow has been deleted successfully.",
        variant: "success",
      });
      load();
    } else {
      const d = await r.json().catch(() => ({}));
      notify({
        title: "Delete failed",
        description: d?.error || "Failed to delete workflow",
        variant: "error",
      });
    }
  }

  async function onDuplicate(workflow) {
    try {
      const res = await fetch("/api/admin/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${workflow.name} (Copy)`,
          description: workflow.description,
          category: workflow.category,
          is_active: false,
          duplicate_from: workflow.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to duplicate workflow");
      notify({
        title: "Workflow duplicated",
        description: "The workflow has been duplicated successfully.",
        variant: "success",
      });
      load();
    } catch (err) {
      notify({
        title: "Duplicate failed",
        description: String(err.message || err),
        variant: "error",
      });
    }
  }

  const availableCategories = useMemo(() => {
    const categorySet = new Set();
    items.forEach((item) => {
      if (item.category) categorySet.add(item.category);
    });
    return Array.from(categorySet).sort();
  }, [items]);

  function formatDate(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <IconGitBranch className="h-5 w-5 text-telnyx-green" />
            Workflows
          </SheetTitle>
        </SheetHeader>

        <div className="px-6 py-3 border-b space-y-3">
          {/* Filters */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={filters.q}
                onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
                placeholder="Search workflows..."
                className="pl-9"
              />
            </div>
            <Select
              value={filters.category || "all"}
              onValueChange={(value) => setFilters((f) => ({ ...f, category: value }))}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {availableCategories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.active || "all"}
              onValueChange={(value) => setFilters((f) => ({ ...f, active: value }))}
            >
              <SelectTrigger className="w-[100px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="true">Active</SelectItem>
                <SelectItem value="false">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Actions */}
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">
              {items.length} workflow{items.length !== 1 ? "s" : ""}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
                <IconRefresh className={`size-4 mr-1 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button size="sm" onClick={onNewWorkflow}>
                <IconPlus className="size-4 mr-1" />
                New
              </Button>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="px-6 py-4 space-y-2">
            {loading ? (
              [...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))
            ) : items.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <IconGitBranch className="size-12 mx-auto mb-3 opacity-30" />
                <p>No workflows found</p>
                <Button variant="link" size="sm" onClick={onNewWorkflow}>
                  Create your first workflow
                </Button>
              </div>
            ) : (
              items.map((workflow) => (
                <div
                  key={workflow.id}
                  className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{workflow.name}</span>
                      <Badge
                        variant="outline"
                        className={
                          workflow.is_active
                            ? "border-green-500 text-green-600"
                            : "border-gray-400 text-gray-500"
                        }
                      >
                        {workflow.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                      {workflow.category && (
                        <span className="capitalize">{workflow.category}</span>
                      )}
                      <span>{workflow.stages_count || 0} stages</span>
                      <span>{workflow.items_count || 0} items</span>
                      <span>{formatDate(workflow.created_at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => onEditWorkflow?.(workflow)}
                      title="Edit workflow"
                    >
                      <IconEdit className="size-4 text-telnyx-green" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => onDuplicate(workflow)}
                      title="Duplicate workflow"
                    >
                      <IconCopy className="size-4 text-blue-500" />
                    </Button>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          title="Delete workflow"
                        >
                          <IconTrash className="size-4 text-red-500" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Delete workflow?</DialogTitle>
                          <DialogDescription>
                            This action cannot be undone. This will permanently delete "
                            {workflow.name}" and all its stages and items.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="flex justify-end gap-2 pt-2">
                          <DialogClose asChild>
                            <Button variant="outline">Cancel</Button>
                          </DialogClose>
                          <DialogClose asChild>
                            <Button
                              variant="destructive"
                              onClick={() => onDelete(workflow.id)}
                            >
                              Delete
                            </Button>
                          </DialogClose>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        <SheetFooter className="px-6 py-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
