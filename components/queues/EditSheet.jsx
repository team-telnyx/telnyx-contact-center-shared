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
import { Switch } from "@/components/ui/switch";
import { Combobox } from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { IconEdit, IconPlus, IconTrash } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const ROUTING_STRATEGIES = [
  { value: "FIFO", label: "FIFO" },
  { value: "Skill-based", label: "Skill-based" },
  { value: "Priority-based", label: "Priority-based" },
];

const OVERFLOW_ACTIONS = [
  { value: "transfer", label: "Transfer" },
  { value: "voicemail", label: "Voicemail" },
  { value: "hangup", label: "Hangup" },
];

/**
 * Edit sheet component for Queues
 * @param {object} props
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 * @param {string} props.queueId - Queue ID to edit
 * @param {function} props.onSaveComplete - Callback when save is complete
 */
export default function EditSheet({
  open,
  onOpenChange,
  queueId,
  onSaveComplete,
}) {
  const [name, setName] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [routingStrategy, setRoutingStrategy] = React.useState("FIFO");
  const [maxWaitTimeSecs, setMaxWaitTimeSecs] = React.useState(600);
  const [maxSize, setMaxSize] = React.useState(100);
  const [timeoutSecs, setTimeoutSecs] = React.useState(300);
  const [overflowQueueId, setOverflowQueueId] = React.useState("");
  const [overflowAction, setOverflowAction] = React.useState("transfer");
  const [priority, setPriority] = React.useState(0);
  const [enabled, setEnabled] = React.useState(true);
  const [active, setActive] = React.useState(true);
  const [skillRequirements, setSkillRequirements] = React.useState({});
  const [priorityRules, setPriorityRules] = React.useState([]);
  const [userAssignments, setUserAssignments] = React.useState([]);
  const [availableQueues, setAvailableQueues] = React.useState([]);
  const [availableUsers, setAvailableUsers] = React.useState([]);
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  // Load queue data when queueId changes
  React.useEffect(() => {
    async function loadQueue() {
      if (!queueId || !open) {
        // Reset form for new queue
        if (open && !queueId) {
          setName("");
          setDisplayName("");
          setDescription("");
          setRoutingStrategy("FIFO");
          setMaxWaitTimeSecs(600);
          setMaxSize(100);
          setTimeoutSecs(300);
          setOverflowQueueId("");
          setOverflowAction("transfer");
          setPriority(0);
          setEnabled(true);
          setActive(true);
          setSkillRequirements({});
          setPriorityRules([]);
          setUserAssignments([]);
        }
        return;
      }

      setLoading(true);
      try {
        const r = await fetch(
          `/api/admin/queues/${encodeURIComponent(queueId)}`,
          {
            cache: "no-store",
          }
        );
        const d = await r.json();
        if (r.ok) {
          setName(d.name || "");
          setDisplayName(d.display_name || "");
          setDescription(d.description || "");
          setRoutingStrategy(d.routing_strategy || "FIFO");
          setMaxWaitTimeSecs(d.max_wait_time_secs || 600);
          setMaxSize(d.max_size || 100);
          setTimeoutSecs(d.timeout_secs || 300);
          setOverflowQueueId(d.overflow_queue_id || "");
          setOverflowAction(d.overflow_action || "transfer");
          setPriority(d.priority || 0);
          setEnabled(d.enabled !== undefined ? d.enabled : true);
          setActive(d.active !== undefined ? Boolean(d.active) : true);
          setActive(d.active !== undefined ? Boolean(d.active) : true);
          setSkillRequirements(
            typeof d.skill_requirements === "string"
              ? JSON.parse(d.skill_requirements)
              : d.skill_requirements || {}
          );
          setPriorityRules(
            typeof d.priority_rules === "string"
              ? JSON.parse(d.priority_rules)
              : d.priority_rules || []
          );
          setUserAssignments(
            (d.userAssignments || []).map((ua) => ({
              userId: ua.user_id,
              username: ua.username,
              name:
                [ua.first_name, ua.last_name].filter(Boolean).join(" ") ||
                ua.nick ||
                ua.username,
              priority: ua.priority || 0,
              enabled: ua.enabled !== undefined ? ua.enabled : true,
            }))
          );
        } else {
          notify({
            title: "Failed to load queue",
            description: d?.error || "",
            variant: "error",
          });
        }
      } catch (err) {
        notify({
          title: "Failed to load queue",
          description: String(err.message || err),
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    }

    if (open && queueId) {
      loadQueue();
    }
  }, [queueId, open]);

  // Load available queues and users
  React.useEffect(() => {
    async function loadData() {
      if (!open) return;

      try {
        // Load queues for overflow selection
        const queuesRes = await fetch("/api/admin/queues?pageSize=1000", {
          cache: "no-store",
        });
        if (queuesRes.ok) {
          const queuesData = await queuesRes.json();
          setAvailableQueues(
            (queuesData.rows || []).filter((q) => q.id !== queueId)
          );
        }

        // Load users for assignments
        const usersRes = await fetch("/api/admin/users?pageSize=1000", {
          cache: "no-store",
        });
        if (usersRes.ok) {
          const usersData = await usersRes.json();
          setAvailableUsers(usersData.rows || []);
        }
      } catch (err) {
        console.error("Failed to load data:", err);
      }
    }

    if (open) {
      loadData();
    }
  }, [open, queueId]);

  function addUserAssignment() {
    if (availableUsers.length === 0) return;
    const firstUser = availableUsers[0];
    setUserAssignments([
      ...userAssignments,
      {
        userId: firstUser.id,
        username: firstUser.username,
        name:
          [firstUser.first_name, firstUser.last_name]
            .filter(Boolean)
            .join(" ") ||
          firstUser.nick ||
          firstUser.username,
        priority: 0,
        enabled: true,
      },
    ]);
  }

  function removeUserAssignment(index) {
    setUserAssignments(userAssignments.filter((_, i) => i !== index));
  }

  function updateUserAssignment(index, field, value) {
    const updated = [...userAssignments];
    updated[index] = { ...updated[index], [field]: value };
    setUserAssignments(updated);
  }

  async function onSave() {
    if (!name.trim()) {
      notify({
        title: "Queue name is required",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        displayName: displayName.trim() || null,
        description: description.trim() || null,
        routingStrategy,
        maxWaitTimeSecs: Number(maxWaitTimeSecs),
        maxSize: Number(maxSize),
        timeoutSecs: Number(timeoutSecs),
        overflowQueueId: overflowQueueId || null,
        overflowAction,
        priority: Number(priority),
        enabled,
        active,
        skillRequirements,
        priorityRules,
        userAssignments: userAssignments.map((ua) => ({
          userId: ua.userId,
          priority: Number(ua.priority),
          enabled: ua.enabled,
        })),
      };

      let r;
      if (queueId) {
        // Update existing queue
        r = await fetch(`/api/admin/queues/${encodeURIComponent(queueId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        // Create new queue
        r = await fetch(`/api/admin/queues`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      if (r.ok) {
        notify({
          title: "Queue updated",
          description: "The queue has been updated successfully",
          variant: "success",
        });
        onOpenChange(false);
        onSaveComplete && onSaveComplete();
      } else {
        const d = await r.json().catch(() => ({}));
        notify({
          title: "Failed to update queue",
          description: d?.error || "",
          variant: "error",
        });
      }
    } catch (err) {
      notify({
        title: "Failed to update queue",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconEdit className="size-5" />
            {queueId ? "Edit Queue" : "Create Queue"}
          </SheetTitle>
        </SheetHeader>

        {/* Scrollable Content Section */}
        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4">
            <CardContent className="p-6 space-y-4">
              {loading ? (
                <>
                  <Skeleton className="h-4 w-40 mb-3" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </>
              ) : (
                <>
                  {/* Basic Information */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Basic Information
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Name *</Label>
                        <Input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="queue-name"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Display Name</Label>
                        <Input
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          placeholder="Queue Display Name"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Description</Label>
                        <Input
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder="Queue description"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Routing Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Routing Settings
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Routing Strategy</Label>
                        <Combobox
                          value={routingStrategy}
                          onChange={(v) => setRoutingStrategy(v)}
                          options={ROUTING_STRATEGIES}
                          placeholder="Select routing strategy"
                          searchable={false}
                        />
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2">
                          <Label className="text-sm">
                            Max Wait Time (secs)
                          </Label>
                          <Input
                            type="number"
                            value={maxWaitTimeSecs}
                            onChange={(e) =>
                              setMaxWaitTimeSecs(Number(e.target.value))
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label className="text-sm">Max Size</Label>
                          <Input
                            type="number"
                            value={maxSize}
                            onChange={(e) => setMaxSize(Number(e.target.value))}
                          />
                        </div>
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Timeout (secs)</Label>
                        <Input
                          type="number"
                          value={timeoutSecs}
                          onChange={(e) =>
                            setTimeoutSecs(Number(e.target.value))
                          }
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Overflow Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Overflow Settings
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Overflow Queue</Label>
                        <Combobox
                          value={overflowQueueId}
                          onChange={(v) => setOverflowQueueId(v)}
                          options={[
                            { value: "", label: "None" },
                            ...availableQueues.map((q) => ({
                              value: q.id,
                              label: q.display_name || q.name,
                            })),
                          ]}
                          placeholder="Select overflow queue"
                          searchable={false}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Overflow Action</Label>
                        <Combobox
                          value={overflowAction}
                          onChange={(v) => setOverflowAction(v)}
                          options={OVERFLOW_ACTIONS}
                          placeholder="Select overflow action"
                          searchable={false}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Queue Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Queue Settings
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Priority</Label>
                        <Input
                          type="number"
                          value={priority}
                          onChange={(e) => setPriority(Number(e.target.value))}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">Enabled</Label>
                        <Switch
                          checked={enabled}
                          onCheckedChange={(v) => setEnabled(Boolean(v))}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="active" className="text-sm font-medium">
                          Active
                        </Label>
                        <Switch
                          checked={active}
                          onCheckedChange={(v) => setActive(Boolean(v))}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* User Assignments */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-muted-foreground">
                        User Assignments
                      </h3>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addUserAssignment}
                      >
                        <IconPlus className="size-4 mr-1" />
                        Add User
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {userAssignments.map((ua, index) => (
                        <div
                          key={index}
                          className="flex items-center gap-2 p-2 border rounded"
                        >
                          <div className="flex-1 grid grid-cols-3 gap-2">
                            <Combobox
                              value={ua.userId}
                              onChange={(v) =>
                                updateUserAssignment(index, "userId", v)
                              }
                              options={availableUsers.map((u) => ({
                                value: u.id,
                                label:
                                  [u.first_name, u.last_name]
                                    .filter(Boolean)
                                    .join(" ") ||
                                  u.nick ||
                                  u.username,
                              }))}
                              placeholder="Select user"
                              searchable={true}
                              contentClassName="w-[300px]"
                            />
                            <Input
                              type="number"
                              placeholder="Priority"
                              value={ua.priority}
                              onChange={(e) =>
                                updateUserAssignment(
                                  index,
                                  "priority",
                                  Number(e.target.value)
                                )
                              }
                              className="w-20"
                            />
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={ua.enabled}
                                onCheckedChange={(v) =>
                                  updateUserAssignment(index, "enabled", v)
                                }
                              />
                              <Label className="text-xs">Enabled</Label>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeUserAssignment(index)}
                          >
                            <IconTrash className="size-4 text-red-500" />
                          </Button>
                        </div>
                      ))}
                      {userAssignments.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          No users assigned. Click "Add User" to assign users to
                          this queue.
                        </p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Fixed Footer */}
        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || loading}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
