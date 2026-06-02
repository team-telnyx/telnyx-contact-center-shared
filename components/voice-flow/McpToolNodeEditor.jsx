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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { VariableTextarea } from "./VariableTextarea";
import { VariableInput } from "./VariableInput";
import McpToolTestSheet from "./McpToolTestSheet";
import {
  IconAlertCircle,
  IconChevronRight,
  IconFlask,
  IconRefresh,
  IconTools,
} from "@tabler/icons-react";

function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value || {}, null, 2);
  } catch {
    return "{}";
  }
}

function getConfigWithoutTestResponse(nodeConfig = {}) {
  const { testResponse: _testResponse, ...configWithoutTestResponse } = nodeConfig;
  return configWithoutTestResponse;
}

export default function McpToolNodeEditor({
  config,
  onChange,
  availableVariables = [],
}) {
  const serverId = config?.serverId || "";
  const toolName = config?.toolName || "";
  const instruction = config?.instruction || "";
  const input = config?.input ?? "{}";
  const responseVariable = config?.responseVariable || "mcp_response";
  const errorVariable = config?.errorVariable || "mcp_error";

  const [servers, setServers] = useState([]);
  const [serversLoading, setServersLoading] = useState(false);
  const [tools, setTools] = useState([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(config?.input && config.input !== "{}"));
  const [testOpen, setTestOpen] = useState(false);
  const latestServerRef = useRef(serverId);
  const latestConfigRef = useRef(config || {});
  latestServerRef.current = serverId;
  latestConfigRef.current = config || {};

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

  const handleTestSuccess = (testResponse, configAtTestStart = latestConfigRef.current) => {
    const latestConfig = latestConfigRef.current;
    const latestComparableConfig = getConfigWithoutTestResponse(latestConfig);
    const testedComparableConfig = getConfigWithoutTestResponse(configAtTestStart);
    if (JSON.stringify(latestComparableConfig) !== JSON.stringify(testedComparableConfig)) return;

    onChange({
      ...latestConfig,
      testResponse: {
        ...testResponse,
        testedAt: new Date().toISOString(),
      },
    });
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

  useEffect(() => {
    if (!selectedTool?.input_schema) return;
    if (JSON.stringify(config?.toolInputSchema || null) === JSON.stringify(selectedTool.input_schema)) return;
    onChange({ ...(config || {}), toolInputSchema: selectedTool.input_schema });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTool?.name, selectedTool?.input_schema]);

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
            onChange({ ...(config || {}), serverId: value, toolName: "", toolInputSchema: null });
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
        <Select
          value={toolName || undefined}
          onValueChange={(value) => {
            const nextTool = tools.find((tool) => tool.name === value) || null;
            onChange({ ...(config || {}), toolName: value, toolInputSchema: nextTool?.input_schema || null });
          }}
          disabled={!selectedServer}
        >
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
        {selectedServer && !toolsLoading && tools.length === 0 && (
          <Badge variant="outline">No allowed tools discovered</Badge>
        )}
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Instruction</Label>
        <VariableTextarea
          value={instruction}
          onChange={(value) => handleChange("instruction", value)}
          availableVariables={availableVariables}
          placeholder="list all Polish numbers, show only active numbers, page size 20"
          rows={4}
        />
        <p className="text-xs text-muted-foreground">
          Describe what this tool should do in plain English. Variables like <code>{"{{customer_country}}"}</code> are supported.
        </p>
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start px-0">
            <IconChevronRight className={`h-4 w-4 mr-1 transition-transform ${advancedOpen ? "rotate-90" : ""}`} />
            Advanced JSON arguments
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2">
          <Label className="text-xs">Advanced Input JSON</Label>
          <VariableTextarea
            value={safeStringify(input)}
            onChange={(value) => handleChange("input", value)}
            availableVariables={availableVariables}
            placeholder={'{\n  "page_size": 20,\n  "filter_country_iso_alpha2": "PL"\n}'}
            rows={6}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            Optional. Use only when you need exact tool arguments. This is merged with the instruction request.
          </p>
        </CollapsibleContent>
      </Collapsible>

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

      {config?.testResponse?.testedAt && (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Last tested: {new Date(config.testResponse.testedAt).toLocaleString()}
        </div>
      )}

      <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setTestOpen(true)} disabled={!serverId || !toolName}>
        <IconFlask className="h-4 w-4 mr-2" />
        Test Tool
      </Button>

      <McpToolTestSheet
        open={testOpen}
        onOpenChange={setTestOpen}
        config={config || {}}
        selectedServer={selectedServer}
        selectedTool={selectedTool}
        onTestSuccess={handleTestSuccess}
      />
    </div>
  );
}
