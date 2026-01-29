"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconChecklist,
  IconEdit,
  IconTrash,
  IconPlus,
  IconCode,
} from "@tabler/icons-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { notify } from "@/components/ToastNotify";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import TaskEditSheet from "@/components/tasks/EditSheet";
import ApiSchemaSheet from "./ApiSchemaSheet";

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In Progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
];

const PRIORITY_OPTIONS = [
  { value: "all", label: "All" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export default function TasksView() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    q: "",
    status: "all",
    task_type: "all",
    priority: "all",
    assigned_to: "all",
  });
  const [loading, setLoading] = useState(false);
  const [editTaskId, setEditTaskId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);
  const [showApiSchema, setShowApiSchema] = useState(false);
  const [users, setUsers] = useState([]);

  // Load users for assigned_to filter
  useEffect(() => {
    async function loadUsers() {
      try {
        const res = await fetch("/api/admin/users?pageSize=100", {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok) {
          setUsers(data.rows || []);
        }
      } catch (err) {
        console.error("Failed to load users:", err);
      }
    }
    loadUsers();
  }, []);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.q) sp.set("q", filters.q);
    if (filters.status && filters.status !== "all")
      sp.set("status", filters.status);
    if (filters.task_type && filters.task_type !== "all")
      sp.set("task_type", filters.task_type);
    if (filters.priority && filters.priority !== "all")
      sp.set("priority", filters.priority);
    if (filters.assigned_to && filters.assigned_to !== "all")
      sp.set("assigned_to", filters.assigned_to);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch tasks");
      setItems(data.rows || []);
      setTotal(Number(data.count || 0));
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
    load();
  }, [query]);

  async function onDelete(id) {
    if (!id) return;
    const r = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (r.ok) {
      notify({ title: "Task deleted", variant: "success" });
      load();
    } else {
      const d = await r.json().catch(() => ({}));
      notify({
        title: "Delete failed",
        description: d?.error || "",
        variant: "error",
      });
    }
  }

  function statusBadgeColor(status) {
    switch (String(status || "open").toLowerCase()) {
      case "open":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
      case "in_progress":
        return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
      case "resolved":
        return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
      case "closed":
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
      case "cancelled":
        return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
      default:
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    }
  }

  function priorityBadgeColor(priority) {
    switch (String(priority || "medium").toLowerCase()) {
      case "low":
        return "bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300";
      case "medium":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
      case "high":
        return "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300";
      case "urgent":
        return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
      default:
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
    }
  }

  function formatDate(dateString) {
    if (!dateString) return "—";
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  }

  function getUserDisplayName(userId) {
    const user = users.find((u) => u.id === userId);
    if (!user) return "—";
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
    return name || user.username || "—";
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Get unique task types from items
  const taskTypes = useMemo(() => {
    const types = new Set();
    items.forEach((item) => {
      if (item.task_type) types.add(item.task_type);
    });
    return Array.from(types).sort();
  }, [items]);

  return (
    <>
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconChecklist className="size-6 text-telnyx-green" /> Tasks
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowApiSchema(true)}>
                <IconCode className="size-4 mr-2" />
                API Schema
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  setFilters({
                    q: "",
                    status: "all",
                    task_type: "all",
                    priority: "all",
                    assigned_to: "all",
                  })
                }
              >
                Clear
              </Button>
              <Button onClick={() => load()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
              <Button
                onClick={() => {
                  setEditTaskId(null);
                  setShowEditSheet(true);
                }}
              >
                <IconPlus className="size-4 mr-2" />
                New Task
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-5 gap-2 items-end">
            <div>
              <label className="text-xs">Search</label>
              <Input
                value={filters.q}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, q: e.target.value }))
                }
                placeholder="title, description, caller…"
              />
            </div>
            <div>
              <label className="text-xs">Status</label>
              <Select
                value={filters.status || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, status: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs">Task Type</label>
              <Select
                value={filters.task_type || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, task_type: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {taskTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type
                        .replace(/_/g, " ")
                        .replace(/\b\w/g, (l) => l.toUpperCase())}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs">Priority</label>
              <Select
                value={filters.priority || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, priority: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs">Assigned To</label>
              <Select
                value={filters.assigned_to || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, assigned_to: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {users.map((user) => {
                    const name = [user.first_name, user.last_name]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <SelectItem key={user.id} value={user.id}>
                        {name || user.username}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>

          {loading ? (
            <div className="border rounded-md overflow-hidden p-4 space-y-2">
              <Skeleton className="h-6 w-40" />
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-[10px] w-[25%]">Title</TableHead>
                    <TableHead className="px-[10px]">Type</TableHead>
                    <TableHead className="px-[10px]">Status</TableHead>
                    <TableHead className="px-[10px]">Priority</TableHead>
                    <TableHead className="px-[10px]">Caller</TableHead>
                    <TableHead className="px-[10px]">Assigned To</TableHead>
                    <TableHead className="px-[10px]">Created</TableHead>
                    <TableHead className="px-[10px] text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((task) => {
                    const rowId = task.id;
                    return (
                      <Fragment key={rowId}>
                        <TableRow>
                          <TableCell className="px-[10px] text-xs">
                            <div
                              className="font-medium truncate"
                              title={task.title}
                            >
                              {task.title}
                            </div>
                            {task.description && (
                              <div className="text-muted-foreground text-xs truncate">
                                {task.description}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {task.task_type
                              ? task.task_type
                                  .replace(/_/g, " ")
                                  .replace(/\b\w/g, (l) => l.toUpperCase())
                              : "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              className={
                                statusBadgeColor(task.status) +
                                " justify-center"
                              }
                              variant="outline"
                            >
                              {task.status || "open"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              className={
                                priorityBadgeColor(task.priority) +
                                " justify-center"
                              }
                              variant="outline"
                            >
                              {task.priority || "medium"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {task.caller_name || "—"}
                            {task.caller_phone && (
                              <div className="text-muted-foreground text-xs">
                                {task.caller_phone}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {getUserDisplayName(task.assigned_to)}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {formatDate(task.created_at)}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditTaskId(task.id);
                                  setShowEditSheet(true);
                                }}
                                className="inline-flex items-center text-telnyx-green"
                                title="Edit task"
                              >
                                <IconEdit className="size-4" />
                              </button>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    type="button"
                                    className="inline-flex items-center text-red-500"
                                    title="Delete task"
                                  >
                                    <IconTrash className="size-4" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Delete task?</DialogTitle>
                                    <DialogDescription>
                                      This action cannot be undone. This will
                                      permanently delete the task "{task.title}
                                      ".
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="flex justify-end gap-2 pt-2">
                                    <DialogClose asChild>
                                      <Button variant="outline">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() => onDelete(task.id)}
                                      >
                                        Delete
                                      </Button>
                                    </DialogClose>
                                  </div>
                                </DialogContent>
                              </Dialog>
                            </div>
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    );
                  })}
                  {items.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={8}
                        className="text-center py-8 text-sm text-muted-foreground"
                      >
                        No tasks
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
        <div className="px-6 pb-6">
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">Total: {total}</div>
            <div className="flex w-full items-center gap-8 lg:w-fit">
              <div className="hidden items-center gap-2 lg:flex">
                <Label htmlFor="rows-per-page" className="text-sm font-medium">
                  Rows per page
                </Label>
                <Select
                  value={`${pageSize}`}
                  onValueChange={(value) => {
                    setPageSize(Number(value));
                    setPage(1);
                  }}
                >
                  <SelectTrigger size="sm" className="w-20" id="rows-per-page">
                    <SelectValue placeholder={pageSize} />
                  </SelectTrigger>
                  <SelectContent side="top">
                    {[10, 20, 30, 40, 50].map((size) => (
                      <SelectItem key={size} value={`${size}`}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-fit items-center justify-center text-sm font-medium">
                Page {page} of {pageCount}
              </div>
              <div className="ml-auto flex items-center gap-2 lg:ml-0">
                <Button
                  variant="outline"
                  className="hidden h-8 w-8 p-0 lg:flex"
                  onClick={() => setPage(1)}
                  disabled={page <= 1}
                >
                  <span className="sr-only">Go to first page</span>
                  <IconChevronsLeft />
                </Button>
                <Button
                  variant="outline"
                  className="size-8"
                  size="icon"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <span className="sr-only">Go to previous page</span>
                  <IconChevronLeft />
                </Button>
                <Button
                  variant="outline"
                  className="size-8"
                  size="icon"
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  disabled={page >= pageCount}
                >
                  <span className="sr-only">Go to next page</span>
                  <IconChevronRight />
                </Button>
                <Button
                  variant="outline"
                  className="hidden size-8 lg:flex"
                  size="icon"
                  onClick={() => setPage(pageCount)}
                  disabled={page >= pageCount}
                >
                  <span className="sr-only">Go to last page</span>
                  <IconChevronsRight />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Edit Sheet */}
      <TaskEditSheet
        open={showEditSheet}
        onOpenChange={setShowEditSheet}
        taskId={editTaskId}
        onSaveComplete={load}
      />

      {/* API Schema Sheet */}
      <ApiSchemaSheet
        entityId="tasks"
        basePath="/api/tasks"
        dbTable="tasks"
        open={showApiSchema}
        onOpenChange={setShowApiSchema}
      />
    </>
  );
}
