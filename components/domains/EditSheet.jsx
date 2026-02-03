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

export default function DomainEditSheet({
  open,
  onOpenChange,
  domainId,
  onSave,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [domain, setDomain] = useState("");
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (!open) return;
    if (domainId) {
      loadDomain();
    } else {
      setDomain("");
      setIsActive(true);
    }
  }, [open, domainId]);

  async function loadDomain() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/domains/${encodeURIComponent(domainId)}`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        throw new Error("Failed to load domain");
      }
      const data = await res.json();
      setDomain(data.domain || "");
      setIsActive(data.active !== undefined ? data.active : true);
    } catch (error) {
      console.error("[DomainEditSheet] Load error:", error);
      notify({
        title: "Failed to load domain",
        description: error.message,
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!domain.trim()) {
      notify({
        title: "Validation error",
        description: "Domain is required",
        variant: "error",
      });
      return;
    }

    // Basic domain validation
    const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i;
    if (!domainRegex.test(domain.trim())) {
      notify({
        title: "Validation error",
        description: "Please enter a valid domain name (e.g., example.com)",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        domain: domain.trim(),
        active: isActive,
      };

      const url = domainId
        ? `/api/admin/domains/${encodeURIComponent(domainId)}`
        : "/api/admin/domains";
      const method = domainId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save domain");
      }

      notify({
        title: "Domain saved",
        description: `Domain ${domainId ? "updated" : "created"} successfully`,
        variant: "success",
      });

      if (onSave) {
        onSave();
      }
      onOpenChange(false);
    } catch (error) {
      console.error("[DomainEditSheet] Save error:", error);
      notify({
        title: "Failed to save domain",
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
            {domainId ? (
              <>
                <IconEdit className="size-5" />
                Edit Domain
              </>
            ) : (
              <>
                <IconPlus className="size-5" />
                Create Domain
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

                  <div className="grid gap-2">
                    <Label htmlFor="domain">Domain *</Label>
                    <Input
                      id="domain"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      placeholder="e.g., example.com"
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
          <Button onClick={handleSave} disabled={saving || !domain.trim()}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
