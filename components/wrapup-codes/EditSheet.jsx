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
import { Combobox } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  STATUS_ICON_OPTIONS,
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
  DEFAULT_STATUS_ICON,
  DEFAULT_STATUS_COLOR,
  STATUS_COLOR_OPTIONS,
} from "@/config/status-icons";

export default function WrapupCodeEditSheet({
  open,
  onOpenChange,
  wrapupCodeId,
  onSave,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [displayOrder, setDisplayOrder] = useState(0);
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState(DEFAULT_STATUS_ICON);
  const [color, setColor] = useState(DEFAULT_STATUS_COLOR);

  useEffect(() => {
    if (!open) return;
    if (wrapupCodeId) {
      loadWrapupCode();
    } else {
      setName("");
      setIsActive(true);
      setIsDefault(false);
      setDisplayOrder(0);
      setDescription("");
      setIcon(DEFAULT_STATUS_ICON);
      setColor(DEFAULT_STATUS_COLOR);
    }
  }, [open, wrapupCodeId]);

  async function loadWrapupCode() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/wrapup-codes/${encodeURIComponent(wrapupCodeId)}`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        throw new Error("Failed to load wrapup code");
      }
      const data = await res.json();
      setName(data.name || "");
      setIsActive(data.is_active !== undefined ? data.is_active : true);
      setIsDefault(data.is_default !== undefined ? data.is_default : false);
      setDisplayOrder(data.display_order || 0);
      setDescription(data.description || "");
      setIcon(data.icon || DEFAULT_STATUS_ICON);
      setColor(data.color || DEFAULT_STATUS_COLOR);
    } catch (error) {
      console.error("[WrapupCodeEditSheet] Load error:", error);
      notify({
        title: "Failed to load wrapup code",
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
        isActive,
        isDefault,
        displayOrder: Number(displayOrder),
        description: description.trim(),
        icon,
        color,
      };

      const url = wrapupCodeId
        ? `/api/admin/wrapup-codes/${encodeURIComponent(wrapupCodeId)}`
        : "/api/admin/wrapup-codes";
      const method = wrapupCodeId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save wrapup code");
      }

      notify({
        title: "Wrapup code saved",
        description: `Wrapup code ${wrapupCodeId ? "updated" : "created"} successfully`,
        variant: "success",
      });

      if (onSave) {
        onSave();
      }
      onOpenChange(false);
    } catch (error) {
      console.error("[WrapupCodeEditSheet] Save error:", error);
      notify({
        title: "Failed to save wrapup code",
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
            {wrapupCodeId ? (
              <>
                <IconEdit className="size-5" />
                Edit Wrapup Code
              </>
            ) : (
              <>
                <IconPlus className="size-5" />
                Create Wrapup Code
              </>
            )}
          </SheetTitle>
        </SheetHeader>

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
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-9 w-full" />
                  </div>
                </>
              ) : (
                <>
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

                  <div className="flex items-center justify-between pb-4 border-b">
                    <Label htmlFor="isDefault" className="text-sm font-medium">
                      Default
                    </Label>
                    <Switch
                      id="isDefault"
                      checked={isDefault}
                      onCheckedChange={setIsDefault}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="name">Name *</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g., Resolved, Escalated"
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="icon">Icon</Label>
                    <Combobox
                      value={icon}
                      onChange={setIcon}
                      options={STATUS_ICON_OPTIONS.map((opt) => ({
                        value: opt.value,
                        label: opt.label,
                        Icon: opt.Icon,
                      }))}
                      placeholder="Select icon"
                      searchable
                      contentClassName="w-[--radix-dropdown-menu-trigger-width]"
                      renderSelected={(selected) => {
                        const Icon =
                          STATUS_ICON_MAP[selected?.value] ||
                          STATUS_NAME_ICON_FALLBACK[name] ||
                          STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                        return (
                          <div className="flex items-center gap-2 min-w-0">
                            <Icon
                              className="size-4 shrink-0"
                              style={color ? { color } : undefined}
                            />
                            <span className="truncate">
                              {selected?.label || "Select icon"}
                            </span>
                          </div>
                        );
                      }}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="color">Icon Color</Label>
                    <Select value={color} onValueChange={setColor}>
                      <SelectTrigger id="color">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_COLOR_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            <span className="flex items-center gap-2">
                              <span
                                className="inline-block size-3 rounded-full border"
                                style={{ backgroundColor: opt.value }}
                              />
                              <span>{opt.label}</span>
                            </span>
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
                      placeholder="Optional description for this code"
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

