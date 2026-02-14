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
import { IconEdit, IconWorld } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

/**
 * Edit sheet component for Web Pages
 */
export default function WebPageEditSheet({
  open,
  onOpenChange,
  pageId,
  onSaveComplete,
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [icon, setIcon] = React.useState("");
  const [orderIndex, setOrderIndex] = React.useState(0);
  const [isActive, setIsActive] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [secrets, setSecrets] = React.useState([]);
  const [showSecretSuggestions, setShowSecretSuggestions] = React.useState(false);
  const [secretInputPosition, setSecretInputPosition] = React.useState({ start: 0, end: 0 });
  const urlInputRef = React.useRef(null);

  // Load page data when pageId changes
  React.useEffect(() => {
    async function loadPage() {
      if (!pageId || !open) {
        // Reset form for new page
        if (!pageId && open) {
          setName("");
          setDescription("");
          setUrl("");
          setIcon("");
          setOrderIndex(0);
          setIsActive(true);
        }
        return;
      }

      setLoading(true);
      try {
        const r = await fetch(`/api/admin/web-pages/${encodeURIComponent(pageId)}`, {
          cache: "no-store",
        });
        const d = await r.json();
        if (r.ok) {
          setName(d.page.name || "");
          setDescription(d.page.description || "");
          setUrl(d.page.url || "");
          setIcon(d.page.icon || "");
          setOrderIndex(d.page.order_index || 0);
          setIsActive(d.page.is_active !== undefined ? d.page.is_active : true);
        } else {
          notify({
            title: "Load failed",
            description: d?.error || "Failed to load web page",
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

    loadPage();
  }, [pageId, open]);

  // Load secrets for autocomplete
  React.useEffect(() => {
    async function loadSecrets() {
      try {
        const r = await fetch("/api/admin/secrets", { cache: "no-store" });
        const d = await r.json();
        if (r.ok && d.secrets) {
          setSecrets(d.secrets);
        }
      } catch (err) {
        // Silently fail - secrets might not be available
        console.error("Failed to load secrets:", err);
      }
    }
    if (open) {
      loadSecrets();
    }
  }, [open]);

  // Handle URL input with secret autocomplete
  function handleUrlChange(e) {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    setUrl(value);

    // Check if user just typed {{ or is typing inside {{...}}
    const beforeCursor = value.substring(0, cursorPos);
    const lastOpen = beforeCursor.lastIndexOf("{{");
    const lastClose = beforeCursor.lastIndexOf("}}");

    if (lastOpen > lastClose && lastOpen !== -1) {
      // User is inside a {{...}} block
      const afterOpen = beforeCursor.substring(lastOpen + 2);
      const secretName = afterOpen.split(/[^a-zA-Z0-9_-]/)[0];
      setSecretInputPosition({ start: lastOpen + 2, end: lastOpen + 2 + secretName.length });
      setShowSecretSuggestions(true);
    } else {
      setShowSecretSuggestions(false);
    }
  }

  function insertSecret(secretName) {
    const cursorPos = secretInputPosition.start - 2; // Position of {{
    const before = url.substring(0, cursorPos);
    const after = url.substring(secretInputPosition.end);
    const newUrl = `${before}{{${secretName}}}${after}`;
    setUrl(newUrl);
    setShowSecretSuggestions(false);
    
    // Focus back on input and set cursor position
    setTimeout(() => {
      if (urlInputRef.current) {
        const newCursorPos = cursorPos + 2 + secretName.length + 2; // After {{secret_name}}
        urlInputRef.current.focus();
        urlInputRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
  }

  // Filter secrets based on current input
  const filteredSecrets = React.useMemo(() => {
    if (!showSecretSuggestions) return [];
    const currentInput = url.substring(secretInputPosition.start, secretInputPosition.end);
    return secrets.filter((secret) =>
      secret.name.toLowerCase().includes(currentInput.toLowerCase())
    );
  }, [secrets, showSecretSuggestions, url, secretInputPosition]);

  async function onSave() {
    // Validate required fields
    if (!name.trim()) {
      notify({
        title: "Validation error",
        description: "Name is required",
        variant: "error",
      });
      return;
    }

    if (!url.trim()) {
      notify({
        title: "Validation error",
        description: "URL is required",
        variant: "error",
      });
      return;
    }

    // Validate URL format (allow {{secret}} placeholders)
    const urlToValidate = url.trim().replace(/\{\{[^}]+\}\}/g, "placeholder");
    try {
      new URL(urlToValidate);
    } catch {
      notify({
        title: "Validation error",
        description: "Invalid URL format",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        url: url.trim(),
        icon: icon.trim() || null,
        order_index: orderIndex || 0,
        is_active: isActive,
      };

      const urlPath = pageId
        ? `/api/admin/web-pages/${encodeURIComponent(pageId)}`
        : `/api/admin/web-pages`;
      const method = pageId ? "PATCH" : "POST";

      const r = await fetch(urlPath, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (r.ok) {
        notify({
          title: pageId ? "Web page updated" : "Web page created",
          description: "The web page has been saved successfully",
          variant: "success",
        });
        onOpenChange(false);
        onSaveComplete && onSaveComplete();
      } else {
        const d = await r.json().catch(() => ({}));
        notify({
          title: "Save failed",
          description: d?.error || "Failed to save web page",
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            {pageId ? (
              <>
                <IconEdit className="size-5" />
                Edit Web Page
              </>
            ) : (
              <>
                <IconWorld className="size-5" />
                New Web Page
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
                </>
              ) : (
                <>
                  {/* Page Information Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Page Information
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">
                          Name <span className="text-red-500">*</span>
                        </Label>
                        <Input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="Enter page name"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Description</Label>
                        <Textarea
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder="Enter page description"
                          rows={3}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">
                          URL <span className="text-red-500">*</span>
                        </Label>
                        <div className="relative">
                          <Input
                            ref={urlInputRef}
                            type="text"
                            value={url}
                            onChange={handleUrlChange}
                            onKeyDown={(e) => {
                              if (showSecretSuggestions && e.key === "Escape") {
                                setShowSecretSuggestions(false);
                              }
                            }}
                            placeholder="https://example.com or https://maps.google.com/maps/embed/v1/place?key={{google_maps_api_key}}&q=..."
                            className="pr-8"
                          />
                          {showSecretSuggestions && filteredSecrets.length > 0 && (
                            <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-md max-h-60 overflow-auto">
                              <div className="p-1">
                                {filteredSecrets.map((secret) => (
                                  <div
                                    key={secret.id}
                                    className="px-2 py-1.5 text-sm cursor-pointer hover:bg-accent rounded-sm"
                                    onClick={() => insertSecret(secret.name)}
                                  >
                                    <div className="font-medium">{secret.name}</div>
                                    {secret.description && (
                                      <div className="text-xs text-muted-foreground">
                                        {secret.description}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Full URL including protocol. Use <code className="bg-muted px-1 rounded">{"{{secret_name}}"}</code> to reference secrets (e.g., API keys).
                        </p>
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Icon</Label>
                        <Input
                          value={icon}
                          onChange={(e) => setIcon(e.target.value)}
                          placeholder="Icon identifier (optional)"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Order Index</Label>
                        <Input
                          type="number"
                          value={orderIndex}
                          onChange={(e) =>
                            setOrderIndex(parseInt(e.target.value) || 0)
                          }
                          placeholder="0"
                        />
                        <p className="text-xs text-muted-foreground">
                          Lower numbers appear first
                        </p>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <Label className="text-sm">Active</Label>
                          <p className="text-xs text-muted-foreground">
                            Show this page in the agent desktop
                          </p>
                        </div>
                        <Switch
                          checked={isActive}
                          onCheckedChange={setIsActive}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Preview Section */}
                  {url && !url.includes("{{") && (() => {
                    try {
                      new URL(url.trim());
                      return true;
                    } catch {
                      return false;
                    }
                  })() && (
                    <div className="pt-4 border-t">
                      <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                        Preview
                      </h3>
                      <div className="relative w-full rounded-lg overflow-hidden border bg-muted/30">
                        <iframe
                          src={url.trim()}
                          title="Page Preview"
                          className="w-full h-64 border-0"
                          sandbox="allow-scripts allow-same-origin allow-forms"
                          loading="lazy"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        Some pages may not display due to security restrictions (X-Frame-Options)
                      </p>
                    </div>
                  )}

                  {url && url.includes("{{") && (
                    <div className="pt-4 border-t">
                      <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                        Preview
                      </h3>
                      <div className="flex items-center justify-center h-32 rounded-lg border border-dashed bg-muted/20">
                        <p className="text-sm text-muted-foreground">
                          Preview unavailable when URL contains secret placeholders
                        </p>
                      </div>
                    </div>
                  )}
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
            {saving ? "Saving..." : pageId ? "Update" : "Create"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
