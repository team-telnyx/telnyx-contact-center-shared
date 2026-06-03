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
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconShieldCheck,
  IconTools,
} from "@tabler/icons-react";

function SecretRefCombobox({ value, onChange }) {
  const [options, setOptions] = React.useState([]);

  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/admin/secrets", { cache: "no-store" });
        const data = await res.json();
        if (!mounted || !res.ok || !data?.ok) return;
        const secrets = Array.isArray(data?.secrets) ? data.secrets : [];
        setOptions(
          secrets
            .filter((secret) => secret?.name || secret?.identifier)
            .map((secret) => ({ value: secret.name || secret.identifier, label: secret.name || secret.identifier })),
        );
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
      placeholder="Select local secret…"
      emptyLabel="No local Contact Center secrets found"
      triggerClassName="w-full"
      searchable
    />
  );
}

export default function MCPServerEditorSheet({ open, serverId, onOpenChange, onSaved, oauthStatus = null }) {
  const id = serverId;
  const isNew = id === "new";
  const toolsRequestRef = React.useRef(0);

  const [name, setName] = React.useState("");
  const [type, setType] = React.useState("sse");
  const [url, setUrl] = React.useState("");
  const [authType, setAuthType] = React.useState("none");
  const [authHeaderName, setAuthHeaderName] = React.useState("");
  const [authScheme, setAuthScheme] = React.useState("");
  const [authSecretName, setAuthSecretName] = React.useState("");
  const [allowedTools, setAllowedTools] = React.useState([]);
  const [availableTools, setAvailableTools] = React.useState([]);
  const [expandedTools, setExpandedTools] = React.useState(new Set());
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [toolsLoading, setToolsLoading] = React.useState(false);
  const [oauthConnecting, setOauthConnecting] = React.useState(false);
  const [authDetecting, setAuthDetecting] = React.useState(false);
  const [detectedAuth, setDetectedAuth] = React.useState(null);
  const [toolsError, setToolsError] = React.useState(null);
  const activeOauthStatus = oauthStatus && oauthStatus.serverId === id ? oauthStatus : null;
  const oauthSessionIssue = authType === "oauth_authorization_code" && /OAuth session|invalid_client|invalid_grant/i.test(String(toolsError || ""));
  const isOAuthConnected = Boolean(authSecretName) && !oauthSessionIssue;
  const latestContextRef = React.useRef({});
  latestContextRef.current = { open, id, isNew, type, url, authType, authHeaderName, authScheme, authSecretName };

  React.useEffect(() => {
    if (!open || !id) return;
    let active = true;
    toolsRequestRef.current += 1;
    setName("");
    setType("sse");
    setUrl("");
    setAuthType("none");
    setAuthHeaderName("");
    setAuthScheme("");
    setAuthSecretName("");
    setAllowedTools([]);
    setAvailableTools([]);
    setExpandedTools(new Set());
    setToolsError(null);
    setDetectedAuth(null);
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
        setAuthType(d.auth_type || "none");
        setAuthHeaderName(d.auth_header_name || "");
        setAuthScheme(d.auth_scheme || "");
        setAuthSecretName(d.auth_secret_name || d.api_key_ref || "");
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
    const requestContext = { open, id, isNew, type, url, authType, authHeaderName, authScheme, authSecretName };
    const isCurrentRequest = () => {
      const latest = latestContextRef.current;
      return toolsRequestRef.current === requestId &&
        requestContext.open === latest.open &&
        requestContext.id === latest.id &&
        requestContext.type === latest.type &&
        requestContext.url === latest.url &&
        requestContext.authType === latest.authType &&
        requestContext.authHeaderName === latest.authHeaderName &&
        requestContext.authScheme === latest.authScheme &&
        requestContext.authSecretName === latest.authSecretName;
    };
    setToolsLoading(true);
    setToolsError(null);
    try {
      const r = await fetch(`/api/admin/mcp-servers/${isNew ? "new" : encodeURIComponent(id)}/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          url,
          auth_type: authType,
          auth_header_name: authHeaderName,
          auth_scheme: authScheme,
          auth_secret_name: authSecretName,
        }),
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

  async function persistServer({ closeAfterSave = false, overrides = {} } = {}) {
    const payload = {
      name,
      type,
      url,
      auth_type: authType,
      auth_header_name: authHeaderName,
      auth_scheme: authScheme,
      auth_secret_name: authSecretName,
      allowed_tools: allowedTools,
      ...overrides,
    };
    const targetId = overrides.id || id;
    const creating = targetId === "new";
    const apiUrl = creating ? "/api/admin/mcp-servers" : `/api/admin/mcp-servers/${encodeURIComponent(targetId)}`;
    const method = creating ? "POST" : "PUT";
    const r = await fetch(apiUrl, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error || "Failed to save MCP server");
    if (closeAfterSave) onSaved?.();
    return d?.data || d;
  }

  async function onSave() {
    setSaving(true);
    try {
      await persistServer({ closeAfterSave: true });
    } catch (error) {
      setToolsError(error?.message || "Failed to save MCP server");
    } finally {
      setSaving(false);
    }
  }

  async function connectServer() {
    if (!name || !type || !url) {
      setToolsError("Name, type, and URL are required before connecting.");
      return;
    }
    if (type !== "http") {
      await loadTools();
      return;
    }
    setOauthConnecting(true);
    setAuthDetecting(true);
    setToolsError(null);
    setDetectedAuth(null);
    try {
      const r = await fetch("/api/admin/mcp-servers/auth/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, url }),
        cache: "no-store",
      });
      const d = await r.json();
      if (!r.ok || !d?.ok) throw new Error(d?.error || "Failed to detect authentication");
      const discovery = d.discovery || null;
      setDetectedAuth(discovery);
      const nextAuthType = discovery?.detected && discovery.authType ? discovery.authType : authType;
      const nextAuthScheme = discovery?.resource || authScheme;
      if (nextAuthType) setAuthType(nextAuthType);
      if (nextAuthScheme) setAuthScheme(nextAuthScheme);

      if (nextAuthType === "oauth_authorization_code") {
        const saved = await persistServer({
          closeAfterSave: false,
          overrides: {
            auth_type: nextAuthType,
            auth_scheme: nextAuthScheme,
          },
        });
        const savedId = saved?.id || id;
        if (!savedId || savedId === "new") throw new Error("MCP server was saved without an id; cannot start OAuth.");
        window.location.href = `/api/admin/mcp-servers/${encodeURIComponent(savedId)}/oauth/begin`;
        return;
      }

      await loadTools();
      setOauthConnecting(false);
      setAuthDetecting(false);
    } catch (error) {
      setToolsError(error?.message || "Failed to connect MCP server");
      setOauthConnecting(false);
      setAuthDetecting(false);
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
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-[88px_minmax(0,1fr)]">
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
                      <div className="flex gap-2">
                        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
                        <Button type="button" variant="outline" onClick={connectServer} disabled={authDetecting || oauthConnecting || !name || !type || !url} className="shrink-0">
                          {authDetecting || oauthConnecting ? "Connecting…" : "Connect"}
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Authentication</label>
                      <Select value={authType} onValueChange={setAuthType}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="bearer">Bearer token</SelectItem>
                          <SelectItem value="oauth_authorization_code">OAuth Authorization Code (PKCE)</SelectItem>
                          <SelectItem value="oauth_client_credentials">OAuth Client Credentials</SelectItem>
                          <SelectItem value="api_key">API key header</SelectItem>
                          <SelectItem value="custom_header">Custom header</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {authType !== "none" && authType !== "oauth_authorization_code" && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Local Secret</label>
                        <SecretRefCombobox value={authSecretName} onChange={setAuthSecretName} />
                        {authType === "oauth_client_credentials" && (
                          <p className="text-xs text-muted-foreground">
                            Store OAuth credentials as JSON {`{"client_id":"...","client_secret":"..."}`} or as client_id:client_secret. Telnyx MCP HTTP uses resource https://api.telnyx.com/v2/mcp.
                          </p>
                        )}
                      </div>
                    )}
                    {authType === "oauth_authorization_code" && (
                      <div className="sm:col-span-2 rounded-2xl border border-telnyx-green/25 bg-gradient-to-br from-telnyx-green/10 via-card to-card p-4 shadow-sm">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-telnyx-green/15 text-telnyx-green ring-1 ring-telnyx-green/25">
                                <IconShieldCheck className="h-5 w-5" />
                              </span>
                              <div>
                                <label className="text-sm font-semibold">OAuth Authorization</label>
                                <p className="text-xs text-muted-foreground">Authorization Code + PKCE for OAuth-protected remote MCP servers.</p>
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {oauthSessionIssue ? (
                                <Badge className="border-transparent bg-red-500/15 text-red-700 dark:text-red-300">
                                  <IconAlertTriangle className="mr-1 h-3.5 w-3.5" /> Reconnect required
                                </Badge>
                              ) : activeOauthStatus?.status === "connected" ? (
                                <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                                  <IconCheck className="mr-1 h-3.5 w-3.5" /> Authentication connected
                                </Badge>
                              ) : activeOauthStatus?.status === "error" ? (
                                <Badge className="border-transparent bg-red-500/15 text-red-700 dark:text-red-300">
                                  <IconAlertTriangle className="mr-1 h-3.5 w-3.5" /> Authentication failed
                                </Badge>
                              ) : isOAuthConnected ? (
                                <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                                  <IconCheck className="mr-1 h-3.5 w-3.5" /> Connected
                                </Badge>
                              ) : (
                                <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300">
                                  Not connected
                                </Badge>
                              )}
                              {authSecretName && <Badge variant="outline" className="max-w-full truncate">Session: {authSecretName}</Badge>}
                              {detectedAuth?.detected && (
                                <Badge className="border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-300">
                                  OAuth auto-detected
                                </Badge>
                              )}
                            </div>
                            {activeOauthStatus?.message && (
                              <p className={activeOauthStatus.status === "error" ? "text-xs text-red-600 dark:text-red-300" : "text-xs text-emerald-700 dark:text-emerald-300"}>
                                {activeOauthStatus.message}
                              </p>
                            )}
                            {detectedAuth?.detected && (
                              <div className="rounded-lg border bg-background/60 p-3 text-xs text-muted-foreground space-y-1">
                                <div><span className="font-medium text-foreground">Resource:</span> {detectedAuth.resourceName || detectedAuth.resource || "OAuth protected MCP resource"}</div>
                                {detectedAuth.authorizationServer && <div><span className="font-medium text-foreground">Authorization server:</span> {detectedAuth.authorizationServer}</div>}
                                {detectedAuth.scope && <div><span className="font-medium text-foreground">Scope:</span> {detectedAuth.scope}</div>}
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground">
                              Click Connect to detect the MCP server authentication method. For OAuth-protected servers, Contact Center saves this draft automatically and starts Authorization Code + PKCE; after callback this sheet reopens so you can review tools and save the final configuration.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    {(authType === "api_key" || authType === "custom_header") && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Header Name</label>
                        <Input value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} placeholder={authType === "api_key" ? "x-api-key" : "Authorization"} />
                      </div>
                    )}
                    {authType === "oauth_client_credentials" && (
                      <div className="space-y-2 sm:col-span-2">
                        <label className="text-sm font-medium">OAuth Resource URL</label>
                        <Input value={authScheme} onChange={(e) => setAuthScheme(e.target.value)} placeholder="https://mcp.example.com/mcp" />
                        <p className="text-xs text-muted-foreground">
                          Required for non-Telnyx OAuth-protected MCP servers. Telnyx MCP URLs automatically use https://api.telnyx.com/v2/mcp.
                        </p>
                      </div>
                    )}
                    {authType === "custom_header" && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Header Scheme (optional)</label>
                        <Input value={authScheme} onChange={(e) => setAuthScheme(e.target.value)} placeholder="Bearer" />
                      </div>
                    )}
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
