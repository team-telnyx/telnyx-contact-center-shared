"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
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
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  IconServer,
  IconTrash,
  IconPencil,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";

export default function MCPServersSection({ values, setValues }) {
  const [availableServers, setAvailableServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedServerId, setSelectedServerId] = useState("");
  const mcpServers = useMemo(
    () => (Array.isArray(values?.mcp_servers) ? values.mcp_servers : []),
    [values?.mcp_servers]
  );

  useEffect(() => {
    async function loadServers() {
      try {
        const res = await fetch("/api/admin/mcp-servers?pageSize=100", {
          cache: "no-store",
        });
        const data = await res.json();
        setAvailableServers(Array.isArray(data.rows) ? data.rows : []);
      } catch (error) {
        console.error("Failed to load MCP servers:", error);
      } finally {
        setLoading(false);
      }
    }
    loadServers();
  }, []);

  const addServer = () => {
    if (!selectedServerId) return;
    const server = availableServers.find((s) => s.id === selectedServerId);
    if (!server) return;

    // Check if already added
    if (mcpServers.some((s) => s.id === selectedServerId)) return;

    // Start with all tools selected by default
    const allTools = Array.isArray(server.allowed_tools)
      ? server.allowed_tools
      : [];

    const newServer = {
      id: server.id,
      allowed_tools: allTools,
    };

    setValues((v) => ({
      ...v,
      mcp_servers: [...mcpServers, newServer],
    }));
    setSelectedServerId("");
  };

  const removeServer = (serverId) => {
    setValues((v) => ({
      ...v,
      mcp_servers: mcpServers.filter((s) => s.id !== serverId),
    }));
  };

  const updateServerTools = (serverId, allowedTools) => {
    setValues((v) => ({
      ...v,
      mcp_servers: mcpServers.map((s) =>
        s.id === serverId ? { ...s, allowed_tools: allowedTools } : s
      ),
    }));
  };

  const availableToAdd = availableServers.filter(
    (s) => !mcpServers.some((ms) => ms.id === s.id)
  );

  return (
    <section className="space-y-3">
      <div className="text-sm font-medium">MCP Servers</div>

      {/* Add Server */}
      <div className="flex items-center gap-2">
        <Select value={selectedServerId} onValueChange={setSelectedServerId}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Select MCP server..." />
          </SelectTrigger>
          <SelectContent>
            {loading && (
              <SelectItem value="_loading" disabled>
                Loading servers...
              </SelectItem>
            )}
            {!loading && availableToAdd.length === 0 && (
              <SelectItem value="_none" disabled>
                No servers available
              </SelectItem>
            )}
            {availableToAdd.map((server) => (
              <SelectItem key={server.id} value={server.id}>
                {server.name} ({server.type.toUpperCase()})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          onClick={addServer}
          disabled={!selectedServerId || loading}
        >
          Add Server
        </Button>
      </div>

      {/* List of Added Servers */}
      {mcpServers.length === 0 && (
        <div className="text-sm text-muted-foreground border rounded-lg p-4 text-center">
          No MCP servers configured for this assistant
        </div>
      )}

      {mcpServers.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {mcpServers.map((mcpServer) => {
            const serverInfo = availableServers.find(
              (s) => s.id === mcpServer.id
            );
            return (
              <MCPServerCard
                key={mcpServer.id}
                mcpServer={mcpServer}
                serverInfo={serverInfo}
                onUpdateTools={updateServerTools}
                onRemove={removeServer}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function MCPServerCard({ mcpServer, serverInfo, onUpdateTools, onRemove }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(mcpServer);
  const [toolsData, setToolsData] = useState([]);
  const [loadingTools, setLoadingTools] = useState(false);

  const loadToolsData = async () => {
    if (!serverInfo) return;
    setLoadingTools(true);
    try {
      const res = await fetch(`/api/admin/mcp-servers/${serverInfo.id}/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: serverInfo.type,
          url: serverInfo.url,
          api_key_ref: serverInfo.api_key_ref,
        }),
      });
      const data = await res.json();
      setToolsData(Array.isArray(data.tools) ? data.tools : []);
    } catch (error) {
      console.error("Failed to load tools data:", error);
      setToolsData([]);
    } finally {
      setLoadingTools(false);
    }
  };

  useEffect(() => {
    if (open && serverInfo) {
      loadToolsData();
    }
  }, [open, serverInfo]);

  if (!serverInfo) {
    return (
      <Card>
        <CardContent className="px-3 py-1">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="text-sm font-medium text-muted-foreground">
                Unknown Server
              </div>
              <div className="text-xs text-muted-foreground">
                Server may have been deleted
              </div>
            </div>
            <button
              className="inline-flex items-center text-red-500 hover:text-red-600"
              onClick={() => onRemove(mcpServer.id)}
            >
              <IconTrash className="size-4" />
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const selectedTools = Array.isArray(mcpServer.allowed_tools)
    ? mcpServer.allowed_tools
    : [];
  const totalTools = Array.isArray(serverInfo.allowed_tools)
    ? serverInfo.allowed_tools.length
    : 0;

  return (
    <Card>
      <CardContent className="px-3 py-1">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="text-sm font-medium inline-flex items-center gap-1.5">
              <IconServer className="size-4" />
              {serverInfo.name}
              <Badge
                variant="outline"
                className={`text-xs ${
                  serverInfo.type === "sse"
                    ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30"
                    : "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30"
                }`}
              >
                {serverInfo.type.toUpperCase()}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground line-clamp-2">
              {serverInfo.url}
            </div>
            <div className="mt-1">
              <Badge
                variant="outline"
                className="text-xs bg-telnyx-green/10 text-telnyx-green border-telnyx-green/30"
              >
                {selectedTools.length} / {totalTools} tools
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Sheet open={open} onOpenChange={(v) => setOpen(v)}>
              <button
                className="inline-flex items-center text-telnyx-green"
                onClick={() => {
                  setDraft(mcpServer);
                  setOpen(true);
                }}
              >
                <IconPencil className="size-4" />
              </button>
              <SheetContent className="w-[90vw] sm:w-[800px] h-full overflow-y-auto mb-4">
                <SheetHeader>
                  <SheetTitle className="inline-flex items-center gap-2">
                    <IconServer className="size-5 text-telnyx-green" />
                    MCP Server - {serverInfo.name}
                  </SheetTitle>
                  <SheetDescription>
                    Configure which tools from this MCP server are available to
                    the assistant
                  </SheetDescription>
                </SheetHeader>

                <div className="mt-6 flex flex-col h-full">
                  <div className="flex-1 overflow-y-auto">
                    <Card className="p-6 mx-4">
                      <MCPServerToolsEditor
                        serverInfo={serverInfo}
                        draft={draft}
                        setDraft={setDraft}
                        toolsData={toolsData}
                        loadingTools={loadingTools}
                      />
                    </Card>
                  </div>

                  <div className="flex justify-end gap-2 pt-4 border-t mt-4 mx-4 mb-4">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setOpen(false);
                        setDraft(mcpServer);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        onUpdateTools(mcpServer.id, draft.allowed_tools || []);
                        setOpen(false);
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
            <button
              className="inline-flex items-center text-red-500 hover:text-red-600"
              onClick={() => onRemove(mcpServer.id)}
            >
              <IconTrash className="size-4" />
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MCPServerToolsEditor({
  serverInfo,
  draft,
  setDraft,
  toolsData,
  loadingTools,
}) {
  const [expandedTools, setExpandedTools] = useState(new Set());

  const selectedTools = Array.isArray(draft.allowed_tools)
    ? draft.allowed_tools
    : [];

  const toggleTool = (toolName) => {
    const newTools = selectedTools.includes(toolName)
      ? selectedTools.filter((t) => t !== toolName)
      : [...selectedTools, toolName];
    setDraft({ ...draft, allowed_tools: newTools });
  };

  const toggleAll = () => {
    if (selectedTools.length === toolsData.length) {
      setDraft({ ...draft, allowed_tools: [] });
    } else {
      setDraft({ ...draft, allowed_tools: toolsData.map((t) => t.name) });
    }
  };

  const toggleToolExpanded = (toolName) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      {!loadingTools && toolsData.length > 0 && (
        <div className="flex items-center justify-between pb-2 border-b">
          <div className="text-sm font-medium">Available Tools</div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">
              {selectedTools.length} / {toolsData.length} selected
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={toggleAll}
              className="h-7 text-xs"
            >
              {selectedTools.length === toolsData.length
                ? "Deselect All"
                : "Select All"}
            </Button>
          </div>
        </div>
      )}

      {/* Content */}
      <div>
        {loadingTools && (
          <div className="text-sm text-muted-foreground">Loading tools...</div>
        )}

        {!loadingTools && toolsData.length === 0 && (
          <div className="text-sm text-muted-foreground border rounded-lg p-4 text-center">
            No tools available from this MCP server
          </div>
        )}

        {!loadingTools && toolsData.length > 0 && (
          <div className="grid gap-2">
            {toolsData.map((tool) => {
              const isExpanded = expandedTools.has(tool.name);
              const hasDescription =
                tool.description && tool.description.trim();

              return (
                <div
                  key={tool.name}
                  className="flex items-start gap-3 p-3 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <Checkbox
                    id={`tool-${draft.id}-${tool.name}`}
                    checked={selectedTools.includes(tool.name)}
                    onCheckedChange={() => toggleTool(tool.name)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 flex-1">
                        <label
                          htmlFor={`tool-${draft.id}-${tool.name}`}
                          className="text-sm font-medium cursor-pointer"
                        >
                          {tool.name}
                        </label>
                        {tool.type && (
                          <Badge
                            variant="outline"
                            className="text-xs text-telnyx-green border-telnyx-green"
                          >
                            {tool.type}
                          </Badge>
                        )}
                      </div>
                      {hasDescription && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 shrink-0"
                          onClick={() => toggleToolExpanded(tool.name)}
                        >
                          {isExpanded ? (
                            <IconChevronUp className="h-4 w-4" />
                          ) : (
                            <IconChevronDown className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                    </div>
                    {hasDescription && isExpanded && (
                      <p className="text-xs text-muted-foreground pt-1">
                        {tool.description}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
