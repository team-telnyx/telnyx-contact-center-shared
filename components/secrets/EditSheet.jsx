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
import { IconEdit, IconPlus } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Edit sheet component for Secrets
 * @param {object} props
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 * @param {number} props.secretId - Secret ID to edit (null for create)
 * @param {function} props.onSaveComplete - Callback when save is complete
 */
export default function SecretEditSheet({
  open,
  onOpenChange,
  secretId,
  onSaveComplete,
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [value, setValue] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  // Load secret data when secretId changes
  React.useEffect(() => {
    async function loadSecret() {
      if (!secretId || !open) {
        // Reset form for new secret
        setName("");
        setDescription("");
        setValue("");
        setExpiresAt("");
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const r = await fetch(`/api/admin/secrets/${secretId}`, {
          cache: "no-store",
        });
        const d = await r.json();
        if (r.ok && d.secret) {
          setName(d.secret.name || "");
          setDescription(d.secret.description || "");
          setValue(""); // Never show the actual value
          setExpiresAt(
            d.secret.expires_at
              ? new Date(d.secret.expires_at).toISOString().slice(0, 16)
              : ""
          );
        } else {
          notify({
            title: "Failed to load secret",
            description: d?.error || "",
            variant: "error",
          });
        }
      } catch (err) {
        notify({
          title: "Failed to load secret",
          description: String(err.message || err),
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    }

    if (open) {
      loadSecret();
    }
  }, [secretId, open]);

  async function onSave() {
    if (!name.trim()) {
      notify({
        title: "Validation error",
        description: "Name is required",
        variant: "error",
      });
      return;
    }

    if (!secretId && !value.trim()) {
      notify({
        title: "Validation error",
        description: "Value is required when creating a new secret",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const url = secretId
        ? `/api/admin/secrets/${secretId}`
        : "/api/admin/secrets";
      const method = secretId ? "PUT" : "POST";

      const body = {
        name: name.trim(),
        description: description.trim(),
        ...(value.trim() && { value: value }),
        expires_at: expiresAt || null,
      };

      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const d = await r.json();
      if (r.ok) {
        notify({
          title: secretId ? "Secret updated" : "Secret created",
          description: `The secret has been ${
            secretId ? "updated" : "created"
          } successfully`,
          variant: "success",
        });
        onOpenChange(false);
        onSaveComplete && onSaveComplete();
      } else {
        notify({
          title: `Failed to ${secretId ? "update" : "create"} secret`,
          description: d?.error || "",
          variant: "error",
        });
      }
    } catch (err) {
      notify({
        title: `Failed to ${secretId ? "update" : "create"} secret`,
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
            {secretId ? (
              <>
                <IconEdit className="size-5" />
                Edit Secret
              </>
            ) : (
              <>
                <IconPlus className="size-5" />
                Create Secret
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
                  <div className="space-y-4">
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
                      <Skeleton className="h-24 w-full" />
                    </div>
                    <div className="grid gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-4">
                    <div className="grid gap-2">
                      <Label htmlFor="name" className="text-sm">
                        Name <span className="text-red-500">*</span>
                      </Label>
                      <Input
                        id="name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g., API_KEY_OPENAI"
                        disabled={!!secretId}
                      />
                      {secretId && (
                        <p className="text-xs text-muted-foreground">
                          Secret name cannot be changed after creation.
                        </p>
                      )}
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="description" className="text-sm">
                        Description
                      </Label>
                      <Input
                        id="description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Optional description"
                      />
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="value" className="text-sm">
                        Value{" "}
                        {!secretId && <span className="text-red-500">*</span>}
                      </Label>
                      <Textarea
                        id="value"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={
                          secretId
                            ? "Leave empty to keep current value"
                            : "Enter secret value"
                        }
                        rows={6}
                        className="font-mono text-sm"
                      />
                      {secretId ? (
                        <p className="text-xs text-muted-foreground">
                          Leave empty to keep the current encrypted value
                          unchanged. Enter a new value to update it.
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          The value will be encrypted and stored securely.
                        </p>
                      )}
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="expires_at" className="text-sm">
                        Expires At (Optional)
                      </Label>
                      <Input
                        id="expires_at"
                        type="datetime-local"
                        value={expiresAt}
                        onChange={(e) => setExpiresAt(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Leave empty for secrets that never expire.
                      </p>
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
            disabled={saving || loading}
          >
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || loading}>
            {saving
              ? secretId
                ? "Updating..."
                : "Creating..."
              : secretId
              ? "Save Changes"
              : "Create Secret"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
