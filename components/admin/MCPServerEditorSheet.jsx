"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Combobox } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
  IconTools,
} from "@tabler/icons-react";

function APIKeyRefCombobox({ value, onChange }) {
  const [options, setOptions] = React.useState([]);

  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/admin/secrets", { cache: "no-store" });
        const data = await res.json();
        if (!mounted || !res.ok) return;
        const secrets = Array.isArray(data?.secrets) ? data.secrets : [];
        setOptions(secrets.map((secret) => ({ value: secret.name, label: secret.name })));
      } catch (_) {}
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Select API key reference…"
      emptyLabel="No secrets found"
      triggerClassName="w-full"
      searchable
    />
  );
}

export default function MCPServerEditorSheet({ open, serverId, onOpenChange, onSaved }) {
  const id = serverId;
  const isNew = id === "new";
  const toolsRequestRef = React.useRef(0);

  const [name, setName] = React.useState("");
  const [type, setType] = React.useState("sse");
  const [url, setUrl] = React.useState("");
  const [apiKeyRef, setApiKeyRef] = React.useState("telnyx_api_key");
  const [allowedTools, setAllowedTools] = React.useState([]);
  const [availableTools, setAvailableTools] = React.useState([]);
  const [expandedTools, setExpandedTools] = React.useState(new Set());
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [toolsLoading, setToolsLoading] = React.useState(false);
  const [toolsError, setToolsError] = React.useState(null);
  const latestContextRef = React.useRef({});
  latestContextRef.current = { open, id, isNew, type, url, apiKeyRef };

  React.useEffect(() => {
    if (!open || !id) return;
    let active = true;
    toolsRequestRef.current += 1;
    setName("");
    setType("sse");
    setUrl("");
    setApiKeyRef("telnyx_api_key");
    setAllowedTools([]);
    setAvailableTools([]);
    setExpandedTools(new Set());
    setToolsError(null);
    if (isNew) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/admin/mcp-servers/${encodeURIComponent(id)}`, { cache: "no-store" });
        const d = await r.json();
        if (!active) return;
        setName(d.name || "");
        setType(d.type || "sse");
        setUrl(d.url || "");
        setApiKeyRef(d.api_key_ref || "telnyx_api_key");
        setAllowedTools(Array.isArray(d.allowed_tools) ? d.allowed_tools : []);
      } catch (_) {
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, id, isNew]);

  async function loadTools() {
    if (!type || !url) {
      setToolsError("Type and URL are required");
      return;
    }
    const requestId = ++toolsRequestRef.current;
    const requestContext = { open, id, isNew, type, url, apiKeyRef };
    const isCurrentRequest = () => {
      const latest = latestContextRef.current;
      return toolsRequestRef.current === requestId &&
        requestContext.open === latest.open &&
        requestContext.id === latest.id &&
        requestContext.type === latest.type &&
        requestContext.url === latest.url &&
        requestContext.apiKeyRef === latest.apiKeyRef;
    };
    setToolsLoading(true);
    setToolsError(null);
    try {
      const r = await fetch(`/api/admin/mcp-servers/${isNew ? "new" : encodeURIComponent(id)}/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, url, api_key_ref: apiKeyRef }),
        cache: "no-store",
      });
      const d = await r.json();
      if (!isCurrentRequest()) return;
      if (!r.ok) {
        setToolsError(d.error || "Failed to load tools");
        setAvailableTools([]);
      } else {
        setAvailableTools(Array.isArray(d.tools) ? d.tools : []);
      }
    } catch (_) {
      if (!isCurrentRequest()) return;
      setToolsError("Failed to connect to MCP server");
      setAvailableTools([]);
    } finally {
      if (toolsRequestRef.current === requestId) setToolsLoading(false);
    }
  }

  React.useEffect(() => {
    if (open && !loading && !isNew && type && url) loadTools();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loading, isNew, id]);

  async function onSave() {
    setSaving(true);
    try {
      const apiUrl = isNew ? "/api/admin/mcp-servers" : `/api/admin/mcp-servers/${encodeURIComponent(id)}`;
      const method = isNew ? "POST" : "PUT";
      const r = await fetch(apiUrl, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type, url, api_key_ref: apiKeyRef, allowed_tools: allowedTools }),
      });
      if (r.ok) onSaved?.();
    } finally {
      setSaving(false);
    }
  }

  const toggleTool = (toolName) => {
    setAllowedTools((prev) => prev.includes(toolName) ? prev.filter((tool) => tool !== toolName) : [...prev, toolName]);
  };

  const toggleAllTools = () => {
    setAllowedTools((prev) => prev.length === availableTools.length ? [] : availableTools.map((tool) => tool.name));
  };

  const toggleToolExpanded = (toolName) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) next.delete(toolName);
      else next.add(toolName);
      return next;
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0 bg-background">
        <SheetHeader className="px-6 py-4 border-b border-border">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconTools className="size-5" />
            {isNew ? "Add MCP Server" : "Edit MCP Server"}
          </SheetTitle>
          <SheetDescription>Configure MCP server connection, discovery, and allowed tools.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4 border-muted-foreground/20 bg-card">
            <CardContent className="p-6 space-y-4 min-w-0">
              {loading ? (
                <div className="space-y-4">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : (
                <>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">Name</label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM MCP" />
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-[88px_minmax(0,1fr)_112px]">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Type</label>
                      <Select value={type} onValueChange={setType}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sse">SSE</SelectItem>
                          <SelectItem value="http">HTTP</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="min-w-0 space-y-2">
                      <label className="text-sm font-medium">URL</label>
                      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Key Ref</label>
                      <APIKeyRefCombobox value={apiKeyRef} onChange={setApiKeyRef} />
                    </div>
                  </div>
                  <div className="grid gap-2 pt-4">
                    <div className="flex items-center justify-between gap-3">
                      <label className="text-sm font-medium">Available Tools</label>
                      <Button size="sm" variant="outline" onClick={loadTools} disabled={toolsLoading || !type || !url}>
                        {toolsLoading ? "Loading…" : isNew ? "Load Tools" : "Refresh Tools"}
                      </Button>
                    </div>
                    {toolsError && (
                      <Alert variant="destructive">
                        <IconAlertTriangle className="h-4 w-4" />
                        <AlertTitle>Connection Error</AlertTitle>
                        <AlertDescription>{toolsError}</AlertDescription>
                      </Alert>
                    )}
                    {!toolsError && toolsLoading && <Skeleton className="h-32 w-full" />}
                    {!toolsError && !toolsLoading && availableTools.length === 0 && (
                      <div className="text-sm text-muted-foreground border rounded-lg p-4 text-center">No tools available from this MCP server</div>
                    )}
                    {!toolsError && !toolsLoading && availableTools.length > 0 && (
                      <div className="border rounded-lg p-4 space-y-3 overflow-hidden">
                        <div className="flex items-center justify-between gap-3 pb-2 border-b">
                          <div className="flex items-center gap-2 min-w-0">
                            <Checkbox id="select-all-mcp-tools" checked={allowedTools.length === availableTools.length} onCheckedChange={toggleAllTools} />
                            <label htmlFor="select-all-mcp-tools" className="text-sm font-medium cursor-pointer">Select All ({availableTools.length} tools)</label>
                          </div>
                          <Badge variant="outline">{allowedTools.length} selected</Badge>
                        </div>
                        <div className="grid gap-3 max-h-96 overflow-y-auto pr-1">
                          {availableTools.map((tool) => {
                            const isExpanded = expandedTools.has(tool.name);
                            return (
                              <div key={tool.name} className="flex items-start gap-3 p-3 border rounded-lg hover:bg-muted/50 transition-colors">
                                <Checkbox id={`tool-${tool.name}`} checked={allowedTools.includes(tool.name)} onCheckedChange={() => toggleTool(tool.name)} className="mt-0.5" />
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex items-start justify-between gap-2">
                                    <label htmlFor={`tool-${tool.name}`} className="text-sm font-medium cursor-pointer truncate" title={tool.name}>{tool.name}</label>
                                    {(tool.description || tool.input_schema) && (
                                      <Button type="button" variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={() => toggleToolExpanded(tool.name)}>
                                        {isExpanded ? <IconChevronUp className="h-4 w-4" /> : <IconChevronDown className="h-4 w-4" />}
                                      </Button>
                                    )}
                                  </div>
                                  {isExpanded && tool.description && <p className="text-xs text-muted-foreground pt-1">{tool.description}</p>}
                                  {isExpanded && tool.input_schema && <pre className="text-[11px] bg-muted rounded p-2 overflow-auto max-h-40">{JSON.stringify(tool.input_schema, null, 2)}</pre>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
        <SheetFooter className="px-6 py-4 border-t border-border flex flex-row justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange?.(false)}>Cancel</Button>
          <Button type="button" onClick={onSave} disabled={saving || !name || !url}>{saving ? "Saving…" : "Save"}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
