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

export default function SkillEditSheet({
  open,
  onOpenChange,
  skillId,
  onSave,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (open) {
      if (skillId) {
        loadSkill();
      } else {
        // Reset form for new skill
        setName("");
        setDescription("");
        setCategory("");
        setIsActive(true);
      }
    }
  }, [open, skillId]);

  async function loadSkill() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/skills/${encodeURIComponent(skillId)}`,
        {
          cache: "no-store",
        }
      );
      if (!res.ok) {
        throw new Error("Failed to load skill");
      }
      const data = await res.json();
      const s = data?.skill || data;
      if (s) {
        setName(s.name || "");
        setDescription(s.description || "");
        setCategory(s.category || "");
        setIsActive(s.is_active !== undefined ? s.is_active : true);
      }
    } catch (error) {
      console.error("[SkillEditSheet] Load error:", error);
      notify({
        title: "Failed to load skill",
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
        description: description.trim(),
        category: category.trim() || null,
        isActive,
      };

      const url = skillId
        ? `/api/admin/skills/${encodeURIComponent(skillId)}`
        : "/api/admin/skills";
      const method = skillId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save skill");
      }

      notify({
        title: "Skill saved",
        description: `Skill ${skillId ? "updated" : "created"} successfully`,
        variant: "success",
      });

      if (onSave) {
        onSave();
      }
      onOpenChange(false);
    } catch (error) {
      console.error("[SkillEditSheet] Save error:", error);
      notify({
        title: "Failed to save skill",
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
            {skillId ? (
              <>
                <IconEdit className="size-5" />
                Edit Skill
              </>
            ) : (
              <>
                <IconPlus className="size-5" />
                Create Skill
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
                      placeholder="e.g., Sales, Support, Technical"
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="category">Category</Label>
                    <Input
                      id="category"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      placeholder="e.g., Customer Service, Technical"
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="description">Description</Label>
                    <Input
                      id="description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Optional description for this skill"
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

