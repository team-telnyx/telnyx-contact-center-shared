"use client";

import React from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconEdit, IconChecklist } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";
import { formatCustomDataText, parseCustomDataText } from "@/lib/custom-data-utils";

const PREDEFINED_TASK_TYPES = [
  "incident",
  "sales_query",
  "complaint",
  "support_request",
  "feature_request",
  "bug_report",
  "other",
];

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In Progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
];

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

/**
 * Edit sheet component for Tasks
 * @param {object} props
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 * @param {string} props.taskId - Task ID to edit (null for new task)
 * @param {function} props.onSaveComplete - Callback when save is complete
 * @param {string} props.prefillContactId - Contact ID to prefill
 * @param {object} props.prefillCallerData - Caller data to prefill {callerName, callerPhone, callerEmail}
 */
export default function TaskEditSheet({
  open,
  onOpenChange,
  taskId,
  onSaveComplete,
  prefillContactId,
  prefillCallerData,
}) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [taskType, setTaskType] = React.useState("");
  const [customTaskType, setCustomTaskType] = React.useState("");
  const [status, setStatus] = React.useState("open");
  const [priority, setPriority] = React.useState("medium");
  const [contactId, setContactId] = React.useState("");
  const [callerName, setCallerName] = React.useState("");
  const [callerPhone, setCallerPhone] = React.useState("");
  const [callerEmail, setCallerEmail] = React.useState("");
  const [assignedTo, setAssignedTo] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [customDataText, setCustomDataText] = React.useState("{}");
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadingContacts, setLoadingContacts] = React.useState(false);
  const [loadingUsers, setLoadingUsers] = React.useState(false);
  const [contacts, setContacts] = React.useState([]);
  const [users, setUsers] = React.useState([]);

  // Load contacts and users for dropdowns
  React.useEffect(() => {
    if (!open) return;

    async function loadContacts() {
      setLoadingContacts(true);
      try {
        const res = await fetch("/api/contacts?pageSize=100", {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok) {
          setContacts(data.rows || []);
        }
      } catch (err) {
        console.error("Failed to load contacts:", err);
      } finally {
        setLoadingContacts(false);
      }
    }

    async function loadUsers() {
      setLoadingUsers(true);
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
      } finally {
        setLoadingUsers(false);
      }
    }

    loadContacts();
    loadUsers();
  }, [open]);

  // Load task data when taskId changes
  React.useEffect(() => {
    async function loadTask() {
      if (!taskId || !open) {
        // Reset form for new task
        if (!taskId && open) {
          setTitle("");
          setDescription("");
          setTaskType("");
          setCustomTaskType("");
          setStatus("open");
          setPriority("medium");
          setContactId(prefillContactId || "");
          setCallerName(prefillCallerData?.callerName || "");
          setCallerPhone(prefillCallerData?.callerPhone || "");
          setCallerEmail(prefillCallerData?.callerEmail || "");
          setAssignedTo("");
          setDueDate("");
          setTags("");
          setCustomDataText("{}");
        }
        return;
      }

      setLoading(true);
      try {
        const r = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
          cache: "no-store",
        });
        const d = await r.json();
        if (r.ok) {
          setTitle(d.title || "");
          setDescription(d.description || "");
          const type = d.task_type || "";
          if (PREDEFINED_TASK_TYPES.includes(type)) {
            setTaskType(type);
            setCustomTaskType("");
          } else {
            setTaskType("custom");
            setCustomTaskType(type);
          }
          setStatus(d.status || "open");
          setPriority(d.priority || "medium");
          setContactId(d.contact_id || "");
          setCallerName(d.caller_name || "");
          setCallerPhone(d.caller_phone || "");
          setCallerEmail(d.caller_email || "");
          setAssignedTo(d.assigned_to || "");
          setDueDate(d.due_date ? d.due_date.split("T")[0] : "");
          setTags(Array.isArray(d.tags) ? d.tags.join(", ") : "");
          setCustomDataText(formatCustomDataText(d.custom_data));
        } else {
          notify({
            title: "Load failed",
            description: d?.error || "Failed to load task",
            variant: "error",
          });
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
    }

    loadTask();
  }, [taskId, open, prefillContactId, prefillCallerData]);

  async function onSave() {
    // Validate required fields
    if (!title.trim()) {
      notify({
        title: "Validation error",
        description: "Title is required",
        variant: "error",
      });
      return;
    }

    const finalTaskType =
      taskType === "custom" ? customTaskType.trim() : taskType;
    if (!finalTaskType) {
      notify({
        title: "Validation error",
        description: "Task type is required",
        variant: "error",
      });
      return;
    }

    let customData;
    try {
      customData = parseCustomDataText(customDataText);
    } catch (err) {
      notify({
        title: "Validation error",
        description: err?.message || "Custom Data must be a valid JSON object",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const tagsArray = tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        task_type: finalTaskType,
        status,
        priority,
        caller_name: callerName.trim() || null,
        caller_phone: callerPhone.trim() || null,
        caller_email: callerEmail.trim() || null,
        contact_id: contactId || null,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        tags: tagsArray,
        custom_data: customData,
      };

      const url = taskId
        ? `/api/tasks/${encodeURIComponent(taskId)}`
        : `/api/tasks`;
      const method = taskId ? "PATCH" : "POST";

      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (r.ok) {
        notify({
          title: taskId ? "Task updated" : "Task created",
          description: "The task has been saved successfully",
          variant: "success",
        });
        onOpenChange(false);
        onSaveComplete && onSaveComplete();
      } else {
        const d = await r.json().catch(() => ({}));
        notify({
          title: "Save failed",
          description: d?.error || "Failed to save task",
          variant: "error",
        });
      }
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

  function getContactDisplayName(contact) {
    if (contact.display_name) return contact.display_name;
    const name = [contact.first_name, contact.last_name]
      .filter(Boolean)
      .join(" ");
    return name || contact.company_name || contact.id;
  }

  function getUserDisplayName(user) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
    return name || user.username || user.id;
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            {taskId ? (
              <>
                <IconEdit className="size-5" />
                Edit Task
              </>
            ) : (
              <>
                <IconChecklist className="size-5" />
                New Task
              </>
            )}
          </SheetTitle>
        </SheetHeader>

        {/* Scrollable Content Section */}
        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4">
            <CardContent className="p-6 space-y-4">
              {loading ? (
                <>
                  <div>
                    <Skeleton className="h-4 w-40 mb-3" />
                    <div className="space-y-3">
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-24 w-full" />
                    </div>
                  </div>
                  <div className="border-t" />
                  <div>
                    <Skeleton className="h-4 w-32 mb-3" />
                    <div className="space-y-3">
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Task Information Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Task Information
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">
                          Title <span className="text-red-500">*</span>
                        </Label>
                        <Input
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder="Enter task title"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Description</Label>
                        <Textarea
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder="Enter task description"
                          rows={4}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">
                          Task Type <span className="text-red-500">*</span>
                        </Label>
                        <Select value={taskType} onValueChange={setTaskType}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select task type" />
                          </SelectTrigger>
                          <SelectContent>
                            {PREDEFINED_TASK_TYPES.map((type) => (
                              <SelectItem key={type} value={type}>
                                {type
                                  .replace(/_/g, " ")
                                  .replace(/\b\w/g, (l) => l.toUpperCase())}
                              </SelectItem>
                            ))}
                            <SelectItem value="custom">Custom</SelectItem>
                          </SelectContent>
                        </Select>
                        {taskType === "custom" && (
                          <Input
                            value={customTaskType}
                            onChange={(e) => setCustomTaskType(e.target.value)}
                            placeholder="Enter custom task type"
                            className="mt-2"
                          />
                        )}
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Status</Label>
                          <Select value={status} onValueChange={setStatus}>
                            <SelectTrigger>
                              <SelectValue />
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
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Priority</Label>
                          <Select value={priority} onValueChange={setPriority}>
                            <SelectTrigger>
                              <SelectValue />
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
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Caller Information Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Caller Information
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">
                          Link to Contact (Optional)
                        </Label>
                        {loadingContacts ? (
                          <Skeleton className="h-9 w-full" />
                        ) : (
                          <Select
                            value={contactId || "none"}
                            onValueChange={(value) =>
                              setContactId(value === "none" ? "" : value)
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select a contact" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              {contacts.map((contact) => (
                                <SelectItem key={contact.id} value={contact.id}>
                                  {getContactDisplayName(contact)}
                                  {contact.company_name &&
                                    ` - ${contact.company_name}`}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Caller Name</Label>
                        <Input
                          value={callerName}
                          onChange={(e) => setCallerName(e.target.value)}
                          placeholder="Caller name"
                        />
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Caller Phone</Label>
                          <Input
                            value={callerPhone}
                            onChange={(e) => setCallerPhone(e.target.value)}
                            placeholder="Caller phone"
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Caller Email</Label>
                          <Input
                            type="email"
                            value={callerEmail}
                            onChange={(e) => setCallerEmail(e.target.value)}
                            placeholder="Caller email"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Assignment Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Assignment
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Assigned To</Label>
                        {loadingUsers ? (
                          <Skeleton className="h-9 w-full" />
                        ) : (
                          <Select
                            value={assignedTo || "unassigned"}
                            onValueChange={(value) =>
                              setAssignedTo(value === "unassigned" ? "" : value)
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select user" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="unassigned">
                                Unassigned
                              </SelectItem>
                              {users.map((user) => (
                                <SelectItem key={user.id} value={user.id}>
                                  {getUserDisplayName(user)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Due Date</Label>
                        <Input
                          type="date"
                          value={dueDate}
                          onChange={(e) => setDueDate(e.target.value)}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Tags</Label>
                        <Input
                          value={tags}
                          onChange={(e) => setTags(e.target.value)}
                          placeholder="Comma-separated tags"
                        />
                        <p className="text-xs text-muted-foreground">
                          Separate multiple tags with commas
                        </p>
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Custom Data</Label>
                        <Textarea
                          value={customDataText}
                          onChange={(e) => setCustomDataText(e.target.value)}
                          placeholder={'{"caseId":"CASE-123","source":"voice"}'}
                          rows={6}
                          className="font-mono text-xs"
                        />
                        <p className="text-xs text-muted-foreground">
                          Enter a valid JSON object. Leave empty to save an empty object.
                        </p>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || loading}>
            {saving ? "Saving..." : taskId ? "Update" : "Create"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
