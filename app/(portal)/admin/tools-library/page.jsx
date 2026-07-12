"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconTools,
  IconPencil,
  IconTrash,
  IconPlus,
  IconFlask,
  IconCheck,
  IconCopy,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconWebhook,
  IconPhoneX,
  IconArrowsLeftRight,
  IconShare2,
  IconMessage,
  IconPhoneIncoming,
  IconDialpad,
  IconDatabaseSearch,
  IconPlayerSkipForward,
  IconUsersPlus,
} from "@tabler/icons-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import ToolEditSheet from "@/components/tools/ToolEditSheet";
import WebhookTestSheet from "@/components/assistants/tools/WebhookTestSheet";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { AiAssistantsSectionPage } from "@/components/assistants/AiAssistantsSectionNav";

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value || "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
      title="Copy ID"
    >
      {copied ? (
        <IconCheck className="size-3 text-green-500" />
      ) : (
        <IconCopy className="size-3" />
      )}
    </button>
  );
}

function toolTypeIcon(type) {
  switch (type) {
    case "webhook":
      return <IconWebhook className="size-4 text-blue-500 shrink-0" />;
    case "hangup":
      return <IconPhoneX className="size-4 text-red-500 shrink-0" />;
    case "transfer":
      return <IconArrowsLeftRight className="size-4 text-orange-500 shrink-0" />;
    case "handoff":
      return <IconShare2 className="size-4 text-purple-500 shrink-0" />;
    case "send_message":
      return <IconMessage className="size-4 text-green-500 shrink-0" />;
    case "invite":
      return <IconPhoneIncoming className="size-4 text-cyan-500 shrink-0" />;
    case "refer":
      return <IconArrowsLeftRight className="size-4 text-amber-500 shrink-0" />;
    case "send_dtmf":
      return <IconDialpad className="size-4 text-indigo-500 shrink-0" />;
    case "retrieval":
      return <IconDatabaseSearch className="size-4 text-telnyx-green shrink-0" />;
    case "skip_turn":
      return <IconPlayerSkipForward className="size-4 text-slate-500 shrink-0" />;
    default:
      return <IconTools className="size-4 text-muted-foreground shrink-0" />;
  }
}

function toolTypeBadge(type) {
  const labels = {
    webhook: "Webhook",
    hangup: "Hangup",
    transfer: "Transfer",
    handoff: "Handoff",
    send_message: "Send Message",
    invite: "Invite",
    refer: "SIP Refer",
    send_dtmf: "Send DTMF",
    retrieval: "Retrieval",
    skip_turn: "Skip Turn",
  };
  return labels[type] || type || "—";
}

export default function ToolsLibraryPage() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ name: "" });

  // Edit/Create Sheet
  const [editSheetOpen, setEditSheetOpen] = useState(false);
  const [editTool, setEditTool] = useState(null); // null = create new

  // Test Sheet
  const [testSheetOpen, setTestSheetOpen] = useState(false);
  const [testTool, setTestTool] = useState(null);

  // Delete Dialog
  const [deleteId, setDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Assign to assistants sheet
  const [assistantAssignSheetOpen, setAssistantAssignSheetOpen] = useState(false);
  const [assignTool, setAssignTool] = useState(null);
  const [assistants, setAssistants] = useState([]);
  const [assistantsLoading, setAssistantsLoading] = useState(false);
  const [assistantsError, setAssistantsError] = useState("");
  const [assistantSearch, setAssistantSearch] = useState("");
  const [selectedAssistantIds, setSelectedAssistantIds] = useState([]);
  const [assigning, setAssigning] = useState(false);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.name) sp.set("name", filters.name);
    return sp.toString();
  }, [page, pageSize, filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ai/tools?${query}`);
      const data = await res.json();
      if (!res.ok || data?.ok === false)
        throw new Error(data?.error || "Failed to fetch tools");
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error(err);
      toast.error("Failed to load tools", { description: err?.message });
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  function handleNewTool() {
    setEditTool(null);
    setEditSheetOpen(true);
  }

  function handleEditTool(tool) {
    setEditTool(tool);
    setEditSheetOpen(true);
  }

  function handleTestTool(tool) {
    setTestTool(tool);
    setTestSheetOpen(true);
  }

  async function loadAssistantsForAssignment() {
    setAssistantsLoading(true);
    setAssistantsError("");
    try {
      const res = await fetch("/api/ai/assistants?all=true", {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to fetch assistants");
      }

      setAssistants(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      console.error(err);
      setAssistantsError(err?.message || String(err));
    } finally {
      setAssistantsLoading(false);
    }
  }

  function handleAssignTool(tool) {
    setAssignTool(tool);
    setSelectedAssistantIds([]);
    setAssistantSearch("");
    setAssistantAssignSheetOpen(true);
    loadAssistantsForAssignment();
  }

  function toggleAssistant(assistantId, checked) {
    setSelectedAssistantIds((ids) => {
      const next = new Set(ids);
      if (checked) next.add(assistantId);
      else next.delete(assistantId);
      return Array.from(next);
    });
  }

  const filteredAssistants = useMemo(() => {
    const text = assistantSearch.trim().toLowerCase();
    if (!text) return assistants;
    return assistants.filter((assistant) => {
      const haystack = [
        assistant?.id,
        assistant?.name,
        assistant?.model,
        assistant?.llm_model,
        assistant?.description,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(text);
    });
  }, [assistantSearch, assistants]);

  async function handleAssignConfirm() {
    if (!assignTool?.id || selectedAssistantIds.length === 0) return;
    setAssigning(true);
    try {
      const res = await fetch(
        `/api/ai/tools/${encodeURIComponent(assignTool.id)}/assign-assistants`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assistantIds: selectedAssistantIds }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to assign tool");
      }
      toast.success("Tool added to selected assistants", {
        description: `${data.updated || 0} assistant(s) updated`,
      });
      setAssistantAssignSheetOpen(false);
      setAssignTool(null);
      setSelectedAssistantIds([]);
    } catch (err) {
      console.error(err);
      toast.error("Failed to assign tool", { description: err?.message });
    } finally {
      setAssigning(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/ai/tools/${encodeURIComponent(deleteId)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false)
        throw new Error(data?.error || "Delete failed");
      toast.success("Tool deleted");
      setDeleteId(null);
      await load();
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete tool", { description: err?.message });
    } finally {
      setDeleting(false);
    }
  }

  function handleSaved() {
    setEditSheetOpen(false);
    load();
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="Tools Library"
        icon={IconTools}
        badges={<Badge variant="secondary">{total} tools</Badge>}
        actions={<Button size="sm" onClick={handleNewTool} title="Create new tool"><IconPlus />New Tool</Button>}
      />
      <AiAssistantsSectionPage activeId="tools">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          {/* Filters */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
            <div className="md:col-span-2">
              <label className="text-xs">Tool Name</label>
              <Input
                value={filters.name}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="e.g. Get Customer Info"
              />
            </div>
            <div className="flex items-end gap-2 md:col-span-2 col-span-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setFilters({ name: "" });
                  setPage(1);
                }}
              >
                Clear
              </Button>
              <Button onClick={() => load()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
            </div>
          </div>

          {/* Table */}
          {loading ? (
            <div className="border rounded-md overflow-hidden">
              <div className="p-4 space-y-3">
                <Skeleton className="h-6 w-40" />
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="border rounded-md overflow-x-auto">
              <Table className="table-fixed min-w-[900px]">
                <TableHeader>
                  <TableRow className="bg-muted">
                    <TableHead className="px-[10px] w-[28%]">Name</TableHead>
                    <TableHead className="px-[10px] w-[30%]">ID</TableHead>
                    <TableHead className="px-[10px] w-[15%]">Type</TableHead>
                    <TableHead className="px-[10px] w-[15%]">Created</TableHead>
                    <TableHead className="px-[10px] text-right w-[12%]">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell
                        className="px-[10px] text-xs w-[28%] overflow-hidden"
                        title={t.display_name || t.name || "<no name>"}
                      >
                        <div className="flex items-center gap-1 min-w-0">
                          {toolTypeIcon(t.type)}
                          <span className="truncate">
                            {t.display_name || t.name || "<no name>"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell
                        className="px-[10px] text-xs w-[30%] overflow-hidden"
                        title={t.id}
                      >
                        <div className="inline-flex items-center gap-1 max-w-full">
                          <span className="truncate min-w-0 font-mono">
                            {t.id}
                          </span>
                          <CopyButton value={t.id} />
                        </div>
                      </TableCell>
                      <TableCell className="px-[10px] text-xs w-[15%] whitespace-nowrap">
                        {toolTypeBadge(t.type)}
                      </TableCell>
                      <TableCell className="px-[10px] text-xs w-[15%] whitespace-nowrap">
                        {t.created_at
                          ? new Date(t.created_at).toLocaleDateString()
                          : "—"}
                      </TableCell>
                      <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                        <div className="inline-flex items-center gap-2 justify-end">
                          {t.type === "webhook" && (
                            <button
                              type="button"
                              onClick={() => handleTestTool(t)}
                              className="inline-flex items-center text-blue-500 hover:text-blue-700"
                              title="Test tool"
                            >
                              <IconFlask className="size-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleAssignTool(t)}
                            className="inline-flex items-center text-purple-500 hover:text-purple-700"
                            title="Assign to assistants"
                            aria-label="Assign to assistants"
                          >
                            <IconUsersPlus className="size-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleEditTool(t)}
                            className="inline-flex items-center text-telnyx-green"
                            title="Edit tool"
                          >
                            <IconPencil className="size-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteId(t.id)}
                            className="inline-flex items-center text-red-500 hover:text-red-700"
                            title="Delete tool"
                          >
                            <IconTrash className="size-4" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {items.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-sm text-muted-foreground"
                      >
                        No tools found. Create your first tool to get started.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>

        {/* Pagination */}
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
                    {[10, 20, 50, 100].map((size) => (
                      <SelectItem key={size} value={`${size}`}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-fit items-center justify-center text-sm font-medium">
                Page {page} of {totalPages}
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
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  <span className="sr-only">Go to next page</span>
                  <IconChevronRight />
                </Button>
                <Button
                  variant="outline"
                  className="hidden size-8 lg:flex"
                  size="icon"
                  onClick={() => setPage(totalPages)}
                  disabled={page >= totalPages}
                >
                  <span className="sr-only">Go to last page</span>
                  <IconChevronsRight />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Edit / Create Sheet */}
      <ToolEditSheet
        open={editSheetOpen}
        onOpenChange={setEditSheetOpen}
        tool={editTool}
        onSaved={handleSaved}
      />

      {/* Test Sheet */}
      <WebhookTestSheet
        open={testSheetOpen}
        onOpenChange={setTestSheetOpen}
        webhookConfig={testTool?.webhook || testTool?.tool_definition}
        standaloneToolId={testTool?.id}
      />

      {/* Assign to Assistants Sheet */}
      <Sheet
        open={assistantAssignSheetOpen}
        onOpenChange={setAssistantAssignSheetOpen}
      >
        <SheetContent className="w-[90vw] sm:w-[800px] h-full flex flex-col overflow-hidden">
          <SheetHeader>
            <SheetTitle className="inline-flex items-center gap-2">
              <IconUsersPlus className="h-5 w-5 text-telnyx-green" />
              Assign to assistants
            </SheetTitle>
            <SheetDescription>
              Add {assignTool?.display_name || assignTool?.name || "this tool"} to one or more AI assistants.
            </SheetDescription>
          </SheetHeader>

          <div className="mx-4 my-2 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {toolTypeIcon(assignTool?.type)}
              <span>{assignTool?.display_name || assignTool?.name || "Unnamed tool"}</span>
              {assignTool?.type && (
                <Badge variant="secondary" className="text-[11px]">
                  {toolTypeBadge(assignTool.type)}
                </Badge>
              )}
            </div>
            <div className="mt-1 text-xs text-muted-foreground font-mono truncate">
              {assignTool?.id}
            </div>
          </div>

          <div className="mx-4 mt-2 flex-1 min-h-0 flex flex-col gap-3">
            <Input
              value={assistantSearch}
              onChange={(e) => setAssistantSearch(e.target.value)}
              placeholder="Search assistants by name, model, or ID…"
            />
            <div className="rounded-lg border bg-background flex-1 min-h-0 overflow-y-auto">
              {assistantsLoading ? (
                <div className="p-6 text-sm text-muted-foreground">Loading assistants…</div>
              ) : assistantsError ? (
                <div className="p-6 text-sm text-red-500">{assistantsError}</div>
              ) : filteredAssistants.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">No assistants found.</div>
              ) : (
                <div className="divide-y">
                  {filteredAssistants.map((assistant) => {
                    const selected = selectedAssistantIds.includes(assistant.id);
                    const model = assistant.model || assistant.llm_model || assistant.llm || "No model";
                    return (
                      <div
                        role="button"
                        tabIndex={0}
                        key={assistant.id}
                        onClick={() => toggleAssistant(assistant.id, !selected)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleAssistant(assistant.id, !selected);
                          }
                        }}
                        className="w-full text-left p-4 hover:bg-muted/50 transition-colors flex items-start gap-3 cursor-pointer"
                      >
                        <Checkbox
                          checked={selected}
                          onCheckedChange={(checked) =>
                            toggleAssistant(assistant.id, Boolean(checked))
                          }
                          onClick={(event) => event.stopPropagation()}
                          className="mt-1"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-sm truncate">
                              {assistant.name || "Unnamed assistant"}
                            </span>
                            <Badge variant="outline" className="text-[11px]">
                              {model}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground line-clamp-2">
                            {assistant.description || assistant.greeting || "No description"}
                          </div>
                          <div className="text-[11px] font-mono text-muted-foreground truncate">
                            {assistant.id}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="border-t p-4 flex gap-2 justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setAssistantAssignSheetOpen(false)}
              disabled={assigning}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleAssignConfirm}
              disabled={assigning || selectedAssistantIds.length === 0}
            >
              {assigning
                ? "Adding…"
                : `Add to Selected Assistants (${selectedAssistantIds.length})`}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Tool</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this tool? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteId(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </AiAssistantsSectionPage>
    </AdminPageShell>
  );
}
