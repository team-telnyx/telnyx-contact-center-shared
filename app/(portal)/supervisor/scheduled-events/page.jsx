"use client";

import React, { Fragment, useEffect, useMemo, useState } from "react";
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
import { Combobox } from "@/components/ui/combobox";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconEye,
  IconTrash,
  IconPlus,
  IconUpload,
  IconDownload,
  IconX,
  IconRobot,
  IconClock,
  IconCheck,
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
  DialogFooter,
} from "@/components/ui/dialog";
import PreviewSheet from "@/components/scheduled-events/PreviewSheet";
import CreateSheet from "@/components/scheduled-events/CreateSheet";
import AiConversationSheet from "@/components/contact-center/AiConversationSheet";
import {
  SupervisorPageHeader,
  SupervisorPageShell,
} from "@/components/contact-center/SupervisorPageLayout";
import { AiAssistantsSectionPage } from "@/components/assistants/AiAssistantsSectionNav";

const neutralActionClass =
  "bg-zinc-950 text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";

export default function SupervisorScheduledEventsPage() {
  const [mounted, setMounted] = useState(false);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    channel: "all",
    assistantId: "",
    fromNumber: "",
    toNumber: "",
  });
  const [loading, setLoading] = useState(false);
  const [assistants, setAssistants] = useState([]);
  const [deleteId, setDeleteId] = useState(null);
  const [deleteAssistantId, setDeleteAssistantId] = useState(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = React.useRef(null);
  const [previewEvent, setPreviewEvent] = useState(null);
  const [showPreviewSheet, setShowPreviewSheet] = useState(false);
  const [showCreateSheet, setShowCreateSheet] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [showConversationSheet, setShowConversationSheet] = useState(false);
  const [conversationInteraction, setConversationInteraction] = useState(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.channel && filters.channel !== "all")
      sp.set("channel", filters.channel);
    if (filters.assistantId) sp.set("assistantId", filters.assistantId);
    if (filters.fromNumber) sp.set("fromNumber", filters.fromNumber);
    if (filters.toNumber) sp.set("toNumber", filters.toNumber);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    // Only load events if an assistant is selected
    if (!filters.assistantId) {
      setItems([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/admin/scheduled-events?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data?.error || "Failed to fetch scheduled events");

      // Apply client-side filtering for from/to numbers
      let filteredItems = data.rows || [];
      if (filters.fromNumber) {
        filteredItems = filteredItems.filter((item) =>
          (item.telnyx_agent_target || "")
            .toLowerCase()
            .includes(filters.fromNumber.toLowerCase()),
        );
      }
      if (filters.toNumber) {
        filteredItems = filteredItems.filter((item) =>
          (item.telnyx_end_user_target || "")
            .toLowerCase()
            .includes(filters.toNumber.toLowerCase()),
        );
      }

      setItems(filteredItems);
      setTotal(filteredItems.length);
    } catch (err) {
      notify({ title: "Load failed", description: String(err.message || err), variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  async function loadAssistants() {
    try {
      const res = await fetch("/api/ai/assistants?pageSize=1000");
      const data = await res.json();
      if (res.ok) {
        const allAssistants = data.items || [];

        // Filter assistants to only those with telephony or messaging configured
        // This indicates they have the capability to have phone numbers assigned
        const assistantsWithPhoneCapability = allAssistants.filter(
          (assistant) => {
            const hasVoiceConfig =
              assistant?.telephony_settings?.default_texml_app_id ||
              assistant?.telephony?.default_texml_app_id;
            const hasMessagingConfig =
              assistant?.messaging_settings?.default_messaging_profile_id ||
              assistant?.messaging?.default_messaging_profile_id;

            // Also check if telephony or messaging is enabled in features
            const enabledFeatures = Array.isArray(assistant?.enabled_features)
              ? assistant.enabled_features
              : [];
            const hasTelephonyEnabled = enabledFeatures.includes("telephony");
            const hasMessagingEnabled = enabledFeatures.includes("messaging");

            return (
              (hasVoiceConfig && hasTelephonyEnabled) ||
              (hasMessagingConfig && hasMessagingEnabled)
            );
          },
        );

        console.log(
          `[Scheduled Events] Filtered ${assistantsWithPhoneCapability.length} assistants with phone capability from ${allAssistants.length} total`,
        );

        setAssistants(assistantsWithPhoneCapability);
      }
    } catch (err) {
      console.error("Failed to load assistants:", err);
    }
  }

  useEffect(() => {
    load();
  }, [query]);

  useEffect(() => {
    loadAssistants();
  }, []);

  function clearFilters() {
    setFilters({
      channel: "all",
      assistantId: "",
      fromNumber: "",
      toNumber: "",
    });
    setPage(1);
  }

  async function onDelete(eventId, assistantId) {
    if (!eventId || !assistantId) return;
    try {
      const r = await fetch(
        `/api/admin/scheduled-events/${encodeURIComponent(
          eventId,
        )}?assistantId=${encodeURIComponent(assistantId)}`,
        {
          method: "DELETE",
        },
      );
      if (r.ok) {
        notify({ title: "Event deleted successfully", variant: "success" });
        load();
      } else {
        const d = await r.json().catch(() => ({}));
        notify({ title: "Delete failed", description: d?.error || "", variant: "error" });
      }
    } catch (err) {
      notify({ title: "Delete failed", description: String(err.message || err), variant: "error" });
    }
  }

  function formatDateTime(dateStr) {
    if (!dateStr) return "—";
    try {
      const date = new Date(dateStr);

      // Check if date is valid
      if (isNaN(date.getTime())) {
        return "—";
      }

      // Format in user's local timezone with YYYY-MM-DD HH:MM format
      return date
        .toLocaleString("en-US", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, // Use user's timezone
        })
        .replace(/(\d+)\/(\d+)\/(\d+),/, "$3-$1-$2");
    } catch (error) {
      console.warn("Date formatting error:", error, "Input:", dateStr);
      return "—";
    }
  }

  function channelBadgeColor(channel) {
    switch (channel) {
      case "phone_call":
        return "text-telnyx-green border-telnyx-green";
      case "sms_chat":
      case "sms":
        return "text-orange-500 border-orange-500";
      default:
        return "text-gray-500 border-gray-300";
    }
  }

  function formatChannelName(channel) {
    switch (channel) {
      case "phone_call":
        return "PHONE CALL";
      case "sms_chat":
      case "sms":
        return "SMS";
      default:
        return String(channel || "—").toUpperCase();
    }
  }

  function formatCallDuration(seconds) {
    if (!seconds && seconds !== 0) return null;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function getStatusBadge(status) {
    switch (String(status || "").toLowerCase()) {
      case "completed":
        return (
          <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-300 text-xs">
            <IconCheck className="size-3 mr-1" /> Completed
          </Badge>
        );
      case "pending":
        return (
          <Badge className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300 border-yellow-300 text-xs">
            <IconClock className="size-3 mr-1" /> Pending
          </Badge>
        );
      case "in_progress":
        return (
          <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-blue-300 text-xs">
            <IconClock className="size-3 mr-1" /> In Progress
          </Badge>
        );
      case "failed":
        return (
          <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-300 text-xs">
            <IconX className="size-3 mr-1" /> Failed
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-xs">
            {String(status || "—").toUpperCase()}
          </Badge>
        );
    }
  }

  async function handleOpenConversation(conversationId) {
    if (!conversationId) return;

    setSelectedConversationId(conversationId);

    // Create a mock interaction object with the conversation_id
    // The AiConversationSheet will use this to load the conversation
    const mockInteraction = {
      metadata: {
        ai_call_control_id: null,
        conversation_id: conversationId,
      },
      conversation_id: conversationId,
    };

    setConversationInteraction(mockInteraction);
    setShowConversationSheet(true);
  }

  function downloadTemplate() {
    const template = `assistant_id,telnyx_conversation_channel,telnyx_end_user_target,telnyx_agent_target,scheduled_at_fixed_datetime,max_retries_client_errors,retry_interval_secs,text
assistant_12345678,phone_call,+15551234567,+15559876543,2025-12-31T12:00:00Z,2,300,
assistant_12345678,sms_chat,+15551234567,+15559876543,2025-12-31T13:00:00Z,0,,Hello! This is a reminder.`;

    const blob = new Blob([template], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "scheduled_events_template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }

  function handleDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  }

  function handleFileInputChange(e) {
    if (e.target.files && e.target.files[0]) {
      handleFileSelect(e.target.files[0]);
    }
  }

  function handleFileSelect(file) {
    if (!file.name.endsWith(".csv")) {
      notify({ title: "Invalid file type", description: "Please select a CSV file", variant: "error" });
      return;
    }
    setImportFile(file);
  }

  function formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  async function handleImport() {
    if (!importFile) {
      notify({ title: "Please select a CSV file", variant: "error" });
      return;
    }

    setImporting(true);
    try {
      const text = await importFile.text();
      const lines = text.split("\n").filter((l) => l.trim());
      if (lines.length < 2) {
        notify({ title: "CSV file is empty or has no data rows", variant: "error" });
        setImporting(false);
        return;
      }

      // Parse CSV
      const headers = lines[0].split(",").map((h) => h.trim());
      const events = [];

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(",").map((v) => v.trim());
        const event = {};
        headers.forEach((header, idx) => {
          event[header] = values[idx] || "";
        });
        events.push(event);
      }

      // Import events
      const res = await fetch("/api/admin/scheduled-events/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Import failed");
      }

      const { results } = data;
      if (results.success > 0) {
        notify({ title: `Successfully imported ${results.success} events`, variant: "success" });
      }
      if (results.failed > 0) {
        notify({ title: `Failed to import ${results.failed} events`, description: results.errors.length > 0
              ? `Row ${results.errors[0].row}: ${results.errors[0].error}`
              : "", variant: "error" });
      }

      setShowImportDialog(false);
      setImportFile(null);
      setDragActive(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      load();
    } catch (err) {
      notify({ title: "Import failed", description: String(err.message || err), variant: "error" });
    } finally {
      setImporting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const canPrev = page > 1;
  const canNext = page < totalPages;

  return (
    <SupervisorPageShell>
      <SupervisorPageHeader
        title="Scheduled Events"
        actions={(
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={downloadTemplate}
              className="gap-2"
            >
              <IconDownload className="size-4" />
              Template
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowImportDialog(true)}
              className="gap-2"
            >
              <IconUpload className="size-4" />
              Import CSV
            </Button>
            <Button
              size="sm"
              onClick={() => setShowCreateSheet(true)}
              className={`gap-2 ${neutralActionClass}`}
            >
              <IconPlus className="size-4" />
              Add Event
            </Button>
          </>
        )}
      />
      <AiAssistantsSectionPage activeId="scheduled-events">
        <Card className="shadow-sm">
          <CardContent className="py-6">

          {/* Filters */}
          <div className="flex items-end gap-4 mb-4">
            <div className="w-[160px]">
              <Label className="text-xs mb-1 block">Channel</Label>
              {mounted ? (
                <Combobox
                  value={filters.channel}
                  onChange={(v) =>
                    setFilters((prev) => ({ ...prev, channel: v }))
                  }
                  options={[
                    { value: "all", label: "All Channels" },
                    { value: "phone_call", label: "Call" },
                    { value: "sms_chat", label: "SMS" },
                  ]}
                  placeholder="All Channels"
                  searchable={true}
                  triggerClassName="w-full"
                />
              ) : (
                <div className="h-9 w-[160px] border rounded-md bg-muted animate-pulse" />
              )}
            </div>
            <div className="w-[160px]">
              <Label className="text-xs mb-1 block">Assistant</Label>
              {mounted ? (
                <Combobox
                  value={filters.assistantId}
                  onChange={(v) =>
                    setFilters((prev) => ({ ...prev, assistantId: v }))
                  }
                  options={[
                    { value: "", label: "Select Assistant" },
                    ...assistants.map((a) => ({
                      value: a.id,
                      label: a.name || a.id,
                    })),
                  ]}
                  placeholder="Select Assistant"
                  searchable={true}
                  triggerClassName="w-full"
                />
              ) : (
                <div className="h-9 w-[160px] border rounded-md bg-muted animate-pulse" />
              )}
            </div>
            <div className="w-[160px]">
              <Label className="text-xs mb-1">From Number</Label>
              <Input
                placeholder="Filter by from..."
                value={filters.fromNumber}
                onChange={(e) =>
                  setFilters((prev) => ({
                    ...prev,
                    fromNumber: e.target.value,
                  }))
                }
              />
            </div>
            <div className="w-[160px]">
              <Label className="text-xs mb-1">To Number</Label>
              <Input
                placeholder="Filter by to..."
                value={filters.toNumber}
                onChange={(e) =>
                  setFilters((prev) => ({
                    ...prev,
                    toNumber: e.target.value,
                  }))
                }
              />
            </div>
            <Button variant="outline" onClick={clearFilters}>
              Clear
            </Button>
            <Button onClick={load}>Refresh</Button>
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
                    <TableHead className="px-[10px] w-[160px]">
                      Scheduled At
                    </TableHead>
                    <TableHead className="px-[10px] w-[100px]">
                      Channel
                    </TableHead>
                    <TableHead className="px-[10px] w-[240px]">
                      Assistant
                    </TableHead>
                    <TableHead className="px-[10px] w-[130px]">From</TableHead>
                    <TableHead className="px-[10px] w-[130px]">To</TableHead>
                    <TableHead className="px-[10px] w-[100px]">
                      Status
                    </TableHead>
                    <TableHead className="px-[10px] w-[100px]">
                      Duration
                    </TableHead>
                    <TableHead className="px-[10px] w-[80px] text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((event) => {
                    const eventId = event.scheduled_event_id || event.id;
                    return (
                      <Fragment key={eventId}>
                        <TableRow>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {formatDateTime(event.scheduled_at_fixed_datetime)}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              className={
                                channelBadgeColor(
                                  event.telnyx_conversation_channel,
                                ) + " justify-center"
                              }
                              variant="outline"
                            >
                              {formatChannelName(
                                event.telnyx_conversation_channel,
                              )}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs truncate">
                            {event.assistant_name || event.assistant_id || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs truncate">
                            {event.telnyx_agent_target || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs truncate">
                            {event.telnyx_end_user_target || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {loading ? (
                              <Skeleton className="h-5 w-20" />
                            ) : (
                              getStatusBadge(event.status)
                            )}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {event.call_duration !== null &&
                            event.call_duration !== undefined ? (
                              <span className="font-mono">
                                {formatCallDuration(event.call_duration)}
                              </span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              {event.conversation_id && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleOpenConversation(
                                      event.conversation_id,
                                    )
                                  }
                                  className="inline-flex items-center text-blue-500 hover:text-blue-600"
                                  title="View conversation history"
                                >
                                  <IconRobot className="size-4" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setPreviewEvent(event);
                                  setShowPreviewSheet(true);
                                }}
                                className="inline-flex items-center text-telnyx-green"
                                title="View event"
                              >
                                <IconEye className="size-4" />
                              </button>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setDeleteId(eventId);
                                      setDeleteAssistantId(event.assistant_id);
                                    }}
                                    className="inline-flex items-center text-red-500 hover:text-red-700"
                                    title="Delete event"
                                  >
                                    <IconTrash className="size-4" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Confirm Delete</DialogTitle>
                                    <DialogDescription>
                                      Are you sure you want to delete this
                                      scheduled event? This action cannot be
                                      undone.
                                    </DialogDescription>
                                  </DialogHeader>
                                  <DialogFooter>
                                    <DialogClose asChild>
                                      <Button variant="outline">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() =>
                                          onDelete(deleteId, deleteAssistantId)
                                        }
                                      >
                                        Delete
                                      </Button>
                                    </DialogClose>
                                  </DialogFooter>
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
                        className="text-center text-sm text-muted-foreground py-8"
                      >
                        {!filters.assistantId
                          ? "Please select an assistant to view scheduled events"
                          : "No scheduled events found"}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4">
            <div className="flex items-center gap-4">
              <div className="text-sm text-muted-foreground">
                Showing {items.length > 0 ? (page - 1) * pageSize + 1 : 0} to{" "}
                {Math.min(page * pageSize, total)} of {total} events
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">
                  Records per page:
                </Label>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => {
                    setPageSize(Number(v));
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-[80px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="25">25</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(1)}
                disabled={!canPrev}
              >
                <IconChevronsLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={!canPrev}
              >
                <IconChevronLeft className="size-4" />
              </Button>
              <div className="text-sm">
                Page {page} of {totalPages}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={!canNext}
              >
                <IconChevronRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(totalPages)}
                disabled={!canNext}
              >
                <IconChevronsRight className="size-4" />
              </Button>
            </div>
          </div>
          </CardContent>
        </Card>
      </AiAssistantsSectionPage>

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Scheduled Events</DialogTitle>
            <DialogDescription>
              Upload a CSV file to import scheduled events. The CSV must have
              the following columns:
            </DialogDescription>
            <ul className="mt-2 space-y-1 text-xs list-disc list-inside text-muted-foreground">
              <li>
                <strong>assistant_id</strong>: The assistant ID (required)
              </li>
              <li>
                <strong>telnyx_conversation_channel</strong>: phone_call or
                sms_chat (required)
              </li>
              <li>
                <strong>telnyx_end_user_target</strong>: Phone number to call or
                text (required)
              </li>
              <li>
                <strong>telnyx_agent_target</strong>: Phone number to call or
                text from (required)
              </li>
              <li>
                <strong>scheduled_at_fixed_datetime</strong>: ISO 8601 datetime
                (required)
              </li>
              <li>
                <strong>max_retries_client_errors</strong>: Retries on busy,
                no-answer, failed, or canceled calls; 0-10 (optional, default 0)
              </li>
              <li>
                <strong>retry_interval_secs</strong>: Delay between retries in
                seconds; 60-86400 (required when retries are greater than 0)
              </li>
              <li>
                <strong>text</strong>: SMS text (optional, required for sms_chat
                channel)
              </li>
            </ul>
          </DialogHeader>
          <div className="space-y-4">
            {!importFile ? (
              <div
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                  dragActive
                    ? "border-telnyx-green bg-telnyx-green/5"
                    : "border-muted-foreground/25 hover:border-muted-foreground/50"
                }`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
              >
                <IconUpload className="size-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-sm font-medium mb-2">
                  Drag & drop your CSV file here
                </p>
                <p className="text-xs text-muted-foreground mb-4">or</p>
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                >
                  Select File
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleFileInputChange}
                  className="hidden"
                />
              </div>
            ) : (
              <div className="border rounded-lg p-4 bg-muted/30">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <IconUpload className="size-8 text-telnyx-green shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">
                        {importFile.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatFileSize(importFile.size)}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setImportFile(null);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                    disabled={importing}
                    className="shrink-0"
                  >
                    <IconX className="size-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowImportDialog(false);
                setImportFile(null);
                setDragActive(false);
                if (fileInputRef.current) {
                  fileInputRef.current.value = "";
                }
              }}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={!importFile || importing}>
              {importing ? "Importing..." : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Sheet */}
      <PreviewSheet
        open={showPreviewSheet}
        onOpenChange={setShowPreviewSheet}
        event={previewEvent}
        onOpenConversation={handleOpenConversation}
      />

      {/* Create Sheet */}
      <CreateSheet
        open={showCreateSheet}
        onOpenChange={setShowCreateSheet}
        assistants={assistants}
        onSaveComplete={load}
      />

      {/* AI Conversation Sheet */}
      {conversationInteraction && (
        <AiConversationSheet
          interaction={conversationInteraction}
          open={showConversationSheet}
          onOpenChange={(open) => {
            setShowConversationSheet(open);
            if (!open) {
              setConversationInteraction(null);
              setSelectedConversationId(null);
            }
          }}
        />
      )}
    </SupervisorPageShell>
  );
}
