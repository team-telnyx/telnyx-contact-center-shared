"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VariableInput } from "./VariableInput";
import McpToolTestSheet from "./McpToolTestSheet";
import { buildEmptyMcpArgsFromSchema, enrichMcpInputSchemaWithDescription, getMcpResponseVariablePayload } from "@/lib/mcp/mcp-argument-builder";
import {
  IconAlertCircle,
  IconFlask,
  IconInfoCircle,
  IconRefresh,
  IconTools,
} from "@tabler/icons-react";

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value || {}, null, 2);
  } catch {
    return "{}";
  }
}

function getSchemaProperties(schema) {
  return schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
}

function getPathValue(source, path) {
  return path.reduce((current, key) => (current == null ? undefined : current[key]), source);
}

function setPathValue(source, path, value) {
  const next = { ...(source || {}) };
  let cursor = next;
  path.forEach((key, index) => {
    if (index === path.length - 1) {
      cursor[key] = value;
      return;
    }
    cursor[key] = cursor[key] && typeof cursor[key] === "object" && !Array.isArray(cursor[key]) ? { ...cursor[key] } : {};
    cursor = cursor[key];
  });
  return next;
}

function schemaType(schema) {
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  if (schema?.properties) return "object";
  return type || "string";
}

function coerceEditorValueForSchema(rawValue, schema) {
  const type = schemaType(schema);
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : rawValue;
  if ((type === "object" || type === "array") && typeof trimmed === "string") {
    if (!trimmed) return type === "array" ? [] : {};
    if (/^\s*[\[{]/.test(trimmed) && !/\{\{[^}]+\}\}/.test(trimmed)) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return rawValue;
      }
    }
  }
  return rawValue;
}

function ArgumentDescriptionInfo({ description, name }) {
  if (!description) return null;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            aria-label={`Show ${name} description`}
          >
            <IconInfoCircle className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" align="start" className="max-w-72 p-3 text-xs leading-relaxed text-muted-foreground">
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ArgumentMappingField({ name, schema, path, value, onValueChange, availableVariables, required = false }) {
  const type = schemaType(schema);
  const requiredNames = Array.isArray(schema?.required) ? schema.required : [];
  const properties = getSchemaProperties(schema);

  if (type === "object" && Object.keys(properties).length > 0) {
    return (
      <div className="rounded-md border border-border p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 min-w-0">
            <Label className="text-xs font-semibold truncate">
              {name} {required && <span className="text-red-500">*</span>}
            </Label>
            <ArgumentDescriptionInfo name={name} description={schema?.description} />
          </div>
          <Badge variant="outline">object</Badge>
        </div>
        <div className="space-y-3 pl-2 border-l border-border">
          {Object.entries(properties).map(([childName, childSchema]) => (
            <ArgumentMappingField
              key={[...path, childName].join(".")}
              name={childName}
              schema={childSchema}
              path={[...path, childName]}
              value={getPathValue(value || {}, [childName])}
              onValueChange={(childPath, childValue) => onValueChange(childPath, childValue)}
              availableVariables={availableVariables}
              required={requiredNames.includes(childName)}
            />
          ))}
        </div>
      </div>
    );
  }

  if (type === "boolean") {
    return (
      <div className="rounded-md border border-border/60 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 min-w-0">
            <Label className="text-xs truncate">
              {name} {required && <span className="text-red-500">*</span>}
            </Label>
            <ArgumentDescriptionInfo name={name} description={schema?.description} />
            <Badge variant="outline" className="ml-1">boolean</Badge>
          </div>
          <Switch
            checked={Boolean(value)}
            onCheckedChange={(checked) => onValueChange(path, Boolean(checked))}
            aria-label={name}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 min-w-0">
          <Label className="text-xs truncate">
            {name} {required && <span className="text-red-500">*</span>}
          </Label>
          <ArgumentDescriptionInfo name={name} description={schema?.description} />
        </div>
        <Badge variant="outline">{type}</Badge>
      </div>
      <VariableInput
        value={value === undefined || value === null ? "" : typeof value === "string" ? value : safeStringify(value)}
        onChange={(nextValue) => onValueChange(path, coerceEditorValueForSchema(nextValue, schema))}
        availableVariables={availableVariables}
        placeholder={type === "array" || type === "object" ? "JSON value or {{variable}}" : `Map ${name} or use {{variable}}`}
        className={type === "array" || type === "object" ? "font-mono text-xs" : ""}
      />
    </div>
  );
}

function getConfigWithoutTestResponse(nodeConfig = {}) {
  const { testResponse: _testResponse, ...configWithoutTestResponse } = nodeConfig;
  return configWithoutTestResponse;
}

function buildToolSelectionPatch(tool) {
  const schema = tool?.input_schema || tool?.inputSchema || null;
  const description = tool?.description || "";
  const displaySchema = enrichMcpInputSchemaWithDescription(schema, description);
  return {
    toolName: tool?.name || "",
    toolInputSchema: schema,
    toolDescription: description,
    input: displaySchema ? safeStringify(buildEmptyMcpArgsFromSchema(displaySchema)) : "{}",
    testResponse: null,
  };
}

export default function McpToolNodeEditor({ config, onChange, availableVariables = [] }) {
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
  const [testOpen, setTestOpen] = useState(false);
  const latestServerRef = useRef(serverId);
  const latestConfigRef = useRef(config || {});
  latestServerRef.current = serverId;
  latestConfigRef.current = config || {};

  const selectedServer = useMemo(() => servers.find((server) => server.id === serverId) || null, [servers, serverId]);
  const selectedTool = useMemo(() => tools.find((tool) => tool.name === toolName) || null, [tools, toolName]);
  const rawToolInputSchema = selectedTool?.input_schema || selectedTool?.inputSchema || config?.toolInputSchema || null;
  const toolDescription = selectedTool?.description || config?.toolDescription || "";
  const toolInputSchema = useMemo(
    () => enrichMcpInputSchemaWithDescription(rawToolInputSchema, toolDescription),
    [rawToolInputSchema, toolDescription],
  );
  const inputObject = useMemo(() => parseJsonObject(input), [input]);
  const schemaProperties = getSchemaProperties(toolInputSchema);
  const topLevelRequiredNames = Array.isArray(toolInputSchema?.required) ? toolInputSchema.required : [];

  const handleChange = (field, value) => onChange({ ...(config || {}), [field]: value });
  const handleToolCallConfigChange = (field, value) => onChange({ ...(config || {}), [field]: value, testResponse: null });
  const updateInputObject = (nextObject) => handleToolCallConfigChange("input", safeStringify(nextObject));

  const handleArgumentChange = (path, value) => {
    updateInputObject(setPathValue(inputObject, path, value));
  };

  const initializeInputFromSchema = (schema = toolInputSchema) => {
    if (!schema) return;
    updateInputObject(buildEmptyMcpArgsFromSchema(schema));
  };

  const handleTestSuccess = (testResponse, configAtTestStart = latestConfigRef.current) => {
    const latestConfig = latestConfigRef.current;
    if (JSON.stringify(getConfigWithoutTestResponse(latestConfig)) !== JSON.stringify(getConfigWithoutTestResponse(configAtTestStart))) return;
    onChange({
      ...latestConfig,
      testResponse: {
        ...testResponse,
        body: getMcpResponseVariablePayload(testResponse),
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
    if (!server?.id) {
      setTools([]);
      return;
    }
    const requestServerId = server.id;
    setToolsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/mcp-servers/${encodeURIComponent(server.id)}/tools`, { cache: "no-store" });
      const data = await response.json();
      if (latestServerRef.current !== requestServerId) return;
      if (!response.ok) throw new Error(data?.error || "Failed to load MCP tools");
      const discoveredTools = Array.isArray(data.tools) ? data.tools : [];
      const allowed = Array.isArray(server.allowed_tools) ? server.allowed_tools : [];
      const filteredTools = allowed.length > 0 ? discoveredTools.filter((tool) => allowed.includes(tool.name)) : discoveredTools;
      setTools(filteredTools);

      const latestConfig = latestConfigRef.current;
      const currentToolStillAvailable = filteredTools.some((tool) => tool.name === latestConfig.toolName);
      if (filteredTools.length > 0 && !currentToolStillAvailable) {
        onChange({
          ...latestConfig,
          ...buildToolSelectionPatch(filteredTools[0]),
        });
      }
    } catch (err) {
      if (latestServerRef.current !== requestServerId) return;
      setTools([]);
      setError(String(err.message || err));
    } finally {
      if (latestServerRef.current === requestServerId) setToolsLoading(false);
    }
  }

  useEffect(() => { loadServers(); }, []);
  useEffect(() => {
    if (selectedServer) loadTools(selectedServer);
    else setTools([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServer?.id]);

  useEffect(() => {
    if (!selectedTool) return;
    const schema = selectedTool.input_schema || selectedTool.inputSchema || null;
    const description = selectedTool.description || "";
    const schemaChanged = JSON.stringify(config?.toolInputSchema || null) !== JSON.stringify(schema);
    const descriptionChanged = (config?.toolDescription || "") !== description;
    if (!schemaChanged && !descriptionChanged) return;
    const currentInput = parseJsonObject(config?.input);
    const displaySchema = enrichMcpInputSchemaWithDescription(schema, description);
    onChange({
      ...(config || {}),
      toolInputSchema: schema,
      toolDescription: description,
      input: Object.keys(currentInput).length === 0 && displaySchema ? safeStringify(buildEmptyMcpArgsFromSchema(displaySchema)) : config?.input,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTool?.name]);

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
            <IconRefresh className="size-4 mr-1" />Refresh
          </Button>
        </div>
        <Select value={serverId || undefined} onValueChange={(value) => onChange({ ...(config || {}), serverId: value, toolName: "", toolInputSchema: null, toolDescription: "", input: "{}", testResponse: null })}>
          <SelectTrigger><SelectValue placeholder={serversLoading ? "Loading servers…" : "Select MCP server"} /></SelectTrigger>
          <SelectContent>
            {servers.map((server) => <SelectItem key={server.id} value={server.id}>{server.name} ({String(server.type || "mcp").toUpperCase()})</SelectItem>)}
          </SelectContent>
        </Select>
        {selectedServer && <p className="text-xs text-muted-foreground truncate">{selectedServer.url}</p>}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">Tool <span className="text-red-500">*</span></Label>
          <Button type="button" variant="ghost" size="sm" onClick={() => loadTools()} disabled={!selectedServer || toolsLoading}>
            <IconTools className="size-4 mr-1" />{toolsLoading ? "Loading…" : "Load tools"}
          </Button>
        </div>
        <Select
          value={toolName || undefined}
          onValueChange={(value) => {
            const nextTool = tools.find((tool) => tool.name === value) || null;
            onChange({ ...(config || {}), ...buildToolSelectionPatch(nextTool) });
          }}
          disabled={!selectedServer}
        >
          <SelectTrigger><SelectValue placeholder={toolsLoading ? "Loading tools…" : "Select allowed tool"} /></SelectTrigger>
          <SelectContent>{tools.map((tool) => <SelectItem key={tool.name} value={tool.name}>{tool.name}</SelectItem>)}</SelectContent>
        </Select>
        {selectedTool?.description && <p className="text-xs text-muted-foreground">{selectedTool.description}</p>}
        {selectedServer && !toolsLoading && tools.length === 0 && <Badge variant="outline">No allowed tools discovered</Badge>}
      </div>

      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label className="text-xs font-semibold">Schema-driven Tool Arguments</Label>
            <p className="text-xs text-muted-foreground mt-1">Assign static values or variables to the selected tool input schema.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => initializeInputFromSchema()} disabled={!toolInputSchema}>Reset from schema</Button>
        </div>
        {Object.keys(schemaProperties).length === 0 ? (
          <div className="text-xs text-muted-foreground rounded border p-3">Select a discovered tool with an input schema to map arguments.</div>
        ) : (
          <div className="space-y-3">
            {Object.entries(schemaProperties).map(([name, schema]) => (
              <ArgumentMappingField
                key={name}
                name={name}
                schema={schema}
                path={[name]}
                value={inputObject[name]}
                onValueChange={handleArgumentChange}
                availableVariables={availableVariables}
                required={topLevelRequiredNames.includes(name)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-xs">Response Variable</Label>
          <VariableInput value={responseVariable} onChange={(value) => handleChange("responseVariable", value)} availableVariables={availableVariables} placeholder="mcp_response" />
          <p className="text-xs text-muted-foreground">Also exposes _text and _structured suffixes.</p>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Error Variable</Label>
          <VariableInput value={errorVariable} onChange={(value) => handleChange("errorVariable", value)} availableVariables={availableVariables} placeholder="mcp_error" />
        </div>
      </div>

      {config?.testResponse?.testedAt && <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">Last tested: {new Date(config.testResponse.testedAt).toLocaleString()}</div>}

      <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setTestOpen(true)} disabled={!serverId || !toolName}>
        <IconFlask className="h-4 w-4 mr-2" />Test Tool
      </Button>

      <McpToolTestSheet open={testOpen} onOpenChange={setTestOpen} config={config || {}} selectedServer={selectedServer} selectedTool={selectedTool} onTestSuccess={handleTestSuccess} />
    </div>
  );
}
