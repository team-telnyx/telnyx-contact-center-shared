"use client";

import React, { useState, useEffect } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { IconEdit, IconPlus } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUS_TYPES = [
  { value: "active", label: "Active" },
  { value: "break", label: "Break" },
];

export default function StatusEditSheet({
  open,
  onOpenChange,
  statusId,
  onSave,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("active");
  const [isActive, setIsActive] = useState(true);
  const [displayOrder, setDisplayOrder] = useState(0);
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (open) {
      if (statusId) {
        loadStatus();
      } else {
        // Reset form for new status
        setName("");
        setType("active");
        setIsActive(true);
        setDisplayOrder(0);
        setDescription("");
      }
    }
  }, [open, statusId]);

  async function loadStatus() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/statuses/${encodeURIComponent(statusId)}`,
        {
          cache: "no-store",
        }
      );
      if (!res.ok) {
        throw new Error("Failed to load status");
      }
      const data = await res.json();
      if (data.ok && data.status) {
        const s = data.status;
        setName(s.name || "");
        setType(s.type || "active");
        setIsActive(s.is_active !== undefined ? s.is_active : true);
        setDisplayOrder(s.display_order || 0);
        setDescription(s.description || "");
      }
    } catch (error) {
      console.error("[StatusEditSheet] Load error:", error);
      notify({
        title: "Failed to load status",
        description: error.message,
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      notify({
        title: "Validation error",
        description: "Name is required",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        type,
        isActive,
        displayOrder: Number(displayOrder),
        description: description.trim(),
      };

      const url = statusId
        ? `/api/admin/statuses/${encodeURIComponent(statusId)}`
        : "/api/admin/statuses";
      const method = statusId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save status");
      }

      notify({
        title: "Status saved",
        description: `Status ${statusId ? "updated" : "created"} successfully`,
        variant: "success",
      });

      if (onSave) {
        onSave();
      }
      onOpenChange(false);
    } catch (error) {
      console.error("[StatusEditSheet] Save error:", error);
      notify({
        title: "Failed to save status",
        description: error.message,
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
            {statusId ? (
              <>
                <IconEdit className="size-5" />
                Edit Status
              </>
            ) : (
              <>
                <IconPlus className="size-5" />
                Create Status
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
                  <div className="flex items-center justify-between pb-4 border-b">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-6 w-11 rounded-full" />
                  </div>
                  <div className="space-y-3">
                    <div className="grid gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                    <div className="grid gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                    <div className="grid gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                    <div className="grid gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Active Switch at the top */}
                  <div className="flex items-center justify-between pb-4 border-b">
                    <Label htmlFor="isActive" className="text-sm font-medium">
                      Active
                    </Label>
                    <Switch
                      id="isActive"
                      checked={isActive}
                      onCheckedChange={setIsActive}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="name">Name *</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g., Available, Busy, Break"
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="type">Type *</Label>
                    <Select value={type} onValueChange={setType}>
                      <SelectTrigger id="type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="border-t" />

                  <div className="grid gap-2">
                    <Label htmlFor="displayOrder">Display Order</Label>
                    <Input
                      id="displayOrder"
                      type="number"
                      value={displayOrder}
                      onChange={(e) => setDisplayOrder(Number(e.target.value))}
                      placeholder="0"
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="description">Description</Label>
                    <Input
                      id="description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Optional description for this status"
                    />
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
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
