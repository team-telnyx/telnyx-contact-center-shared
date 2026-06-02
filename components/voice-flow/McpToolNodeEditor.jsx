"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VariableTextarea } from "./VariableTextarea";
import { VariableInput } from "./VariableInput";
import { IconAlertCircle, IconRefresh, IconTools } from "@tabler/icons-react";

function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value || {}, null, 2);
  } catch {
    return "{}";
  }
}

export default function McpToolNodeEditor({
  config,
  onChange,
  availableVariables = [],
}) {
  const serverId = config?.serverId || "";
  const toolName = config?.toolName || "";
  const input = config?.input ?? "{}";
  const responseVariable = config?.responseVariable || "mcp_response";
  const errorVariable = config?.errorVariable || "mcp_error";

  const [servers, setServers] = useState([]);
  const [serversLoading, setServersLoading] = useState(false);
  const [tools, setTools] = useState([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [error, setError] = useState(null);
  const latestServerRef = useRef(serverId);
  latestServerRef.current = serverId;

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === serverId) || null,
    [servers, serverId],
  );
  const selectedTool = useMemo(
    () => tools.find((tool) => tool.name === toolName) || null,
    [tools, toolName],
  );

  const handleChange = (field, value) => {
    onChange({ ...(config || {}), [field]: value });
  };

  async function loadServers() {
    setServersLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/mcp-servers?page=1&pageSize=100", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Failed to load MCP servers");
      setServers(Array.isArray(data.rows) ? data.rows : []);
    } catch (err) {
      setServers([]);
      setError(String(err.message || err));
    } finally {
      setServersLoading(false);
    }
  }

  async function loadTools(server = selectedServer) {
    if (!server?.id || !server?.type || !server?.url) {
      setTools([]);
      return;
    }
    const requestServerId = server.id;
    setToolsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/mcp-servers/${encodeURIComponent(server.id)}/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          type: server.type,
          url: server.url,
          api_key_ref: server.api_key_ref,
        }),
      });
      const data = await response.json();
      if (latestServerRef.current !== requestServerId) return;
      if (!response.ok) throw new Error(data?.error || "Failed to load MCP tools");
      const discoveredTools = Array.isArray(data.tools) ? data.tools : [];
      const allowed = Array.isArray(server.allowed_tools) ? server.allowed_tools : [];
      setTools(
        allowed.length > 0
          ? discoveredTools.filter((tool) => allowed.includes(tool.name))
          : discoveredTools,
      );
    } catch (err) {
      if (latestServerRef.current !== requestServerId) return;
      setTools([]);
      setError(String(err.message || err));
    } finally {
      if (latestServerRef.current === requestServerId) setToolsLoading(false);
    }
  }

  useEffect(() => {
    loadServers();
  }, []);

  useEffect(() => {
    if (selectedServer) loadTools(selectedServer);
    else setTools([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServer?.id]);

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertTitle>MCP configuration issue</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">MCP Server <span className="text-red-500">*</span></Label>
          <Button type="button" variant="ghost" size="sm" onClick={loadServers} disabled={serversLoading}>
            <IconRefresh className="size-4 mr-1" />
            Refresh
          </Button>
        </div>
        <Select
          value={serverId || undefined}
          onValueChange={(value) => {
            onChange({ ...(config || {}), serverId: value, toolName: "" });
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder={serversLoading ? "Loading servers…" : "Select MCP server"} />
          </SelectTrigger>
          <SelectContent>
            {servers.map((server) => (
              <SelectItem key={server.id} value={server.id}>
                {server.name} ({String(server.type || "mcp").toUpperCase()})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedServer && <p className="text-xs text-muted-foreground truncate">{selectedServer.url}</p>}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">Tool <span className="text-red-500">*</span></Label>
          <Button type="button" variant="ghost" size="sm" onClick={() => loadTools()} disabled={!selectedServer || toolsLoading}>
            <IconTools className="size-4 mr-1" />
            {toolsLoading ? "Loading…" : "Load tools"}
          </Button>
        </div>
        <Select value={toolName || undefined} onValueChange={(value) => handleChange("toolName", value)} disabled={!selectedServer}>
          <SelectTrigger>
            <SelectValue placeholder={toolsLoading ? "Loading tools…" : "Select allowed tool"} />
          </SelectTrigger>
          <SelectContent>
            {tools.map((tool) => (
              <SelectItem key={tool.name} value={tool.name}>{tool.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedTool?.description && <p className="text-xs text-muted-foreground">{selectedTool.description}</p>}
        {selectedTool?.input_schema && (
          <pre className="text-[11px] bg-muted rounded p-2 overflow-auto max-h-44">{JSON.stringify(selectedTool.input_schema, null, 2)}</pre>
        )}
        {selectedServer && !toolsLoading && tools.length === 0 && (
          <Badge variant="outline">No allowed tools discovered</Badge>
        )}
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Tool Input JSON</Label>
        <VariableTextarea
          value={safeStringify(input)}
          onChange={(value) => handleChange("input", value)}
          availableVariables={availableVariables}
          placeholder={'{\n  "phone": "{{from}}",\n  "query": "Find customer {{from}}"\n}'}
          rows={8}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Supports variables. A pure value like <code>{"{{contact_record}}"}</code> keeps the original object/array type at runtime.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-xs">Response Variable</Label>
          <VariableInput
            value={responseVariable}
            onChange={(value) => handleChange("responseVariable", value)}
            availableVariables={availableVariables}
            placeholder="mcp_response"
          />
          <p className="text-xs text-muted-foreground">Also exposes _text and _structured suffixes.</p>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Error Variable</Label>
          <VariableInput
            value={errorVariable}
            onChange={(value) => handleChange("errorVariable", value)}
            availableVariables={availableVariables}
            placeholder="mcp_error"
          />
        </div>
      </div>
    </div>
  );
}
