"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { IconBraces, IconCode, IconInfoCircle, IconServer, IconTools } from "@tabler/icons-react";

function safeStringify(value) {
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function objectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function schemaProperties(schema) {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(properties).map(([name, definition]) => ({
    name,
    required: required.has(name),
    type: Array.isArray(definition?.type) ? definition.type.join(" | ") : definition?.type || definition?.format || "any",
    description: definition?.description || definition?.title || "",
  }));
}

function DetailPill({ label, value }) {
  if (!value) return null;
  return (
    <div className="rounded-lg border bg-background/60 px-3 py-2 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xs font-medium text-foreground truncate">{value}</div>
    </div>
  );
}

function JsonViewerCard({ title, icon: Icon = IconCode, value, emptyLabel = "Not provided" }) {
  const hasValue = value !== null && value !== undefined && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
  return (
    <Card className="border-muted-foreground/20 bg-card">
      <CardContent className="p-4 space-y-3 min-w-0">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-telnyx-green/15 text-telnyx-green ring-1 ring-telnyx-green/25">
            <Icon className="h-4 w-4" />
          </span>
          <div className="text-sm font-semibold">{title}</div>
        </div>
        {hasValue ? (
          <CodeBlock code={safeStringify(value)} language="json" showLineNumbers maxHeight={360}>
            <CodeBlockCopyButton type="button" />
          </CodeBlock>
        ) : (
          <div className="rounded-lg border border-dashed bg-background/50 p-4 text-sm text-muted-foreground">{emptyLabel}</div>
        )}
      </CardContent>
    </Card>
  );
}

export default function MCPToolDetailsSheet({ open, onOpenChange, server, tool }) {
  const inputSchema = tool?.input_schema || tool?.inputSchema || {};
  const outputSchema = tool?.output_schema || tool?.outputSchema || null;
  const properties = schemaProperties(inputSchema);
  const rawTool = React.useMemo(() => {
    if (!tool) return null;
    return {
      name: tool.name,
      title: tool.title || null,
      description: tool.description || "",
      type: tool.type || "function",
      input_schema: inputSchema,
      output_schema: outputSchema,
      schema_hash: tool.schema_hash || null,
      enabled: tool.enabled !== false,
      last_discovered_at: tool.last_discovered_at || null,
      mcp_server_id: tool.mcp_server_id || server?.id || null,
    };
  }, [inputSchema, outputSchema, server?.id, tool]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0 bg-background">
        <SheetHeader className="px-6 py-4 border-b border-border">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2 min-w-0">
            <IconTools className="size-5 shrink-0" />
            <span className="truncate">{tool?.title || tool?.name || "MCP Tool"}</span>
          </SheetTitle>
          <SheetDescription className="break-words">
            Tool metadata, description, and schemas discovered from {server?.name || "the MCP server"}.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-5 my-4 space-y-4">
            <Card className="border-muted-foreground/20 bg-card">
              <CardContent className="p-6 space-y-4 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="bg-telnyx-green/10 text-telnyx-green border-telnyx-green/30">
                    {tool?.name || "unknown_tool"}
                  </Badge>
                  {tool?.title && tool.title !== tool.name && <Badge variant="secondary">{tool.title}</Badge>}
                  <Badge variant="outline" className="text-xs">{tool?.enabled === false ? "Disabled" : "Enabled"}</Badge>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <DetailPill label="Server" value={server?.name} />
                  <DetailPill label="Transport" value={server?.type ? String(server.type).toUpperCase() : null} />
                  <DetailPill label="Schema hash" value={tool?.schema_hash} />
                  <DetailPill label="Last discovered" value={tool?.last_discovered_at ? new Date(tool.last_discovered_at).toLocaleString() : null} />
                </div>

                {server?.url && (
                  <div className="rounded-lg border bg-background/60 p-3 text-xs text-muted-foreground min-w-0">
                    <div className="flex items-center gap-2 text-foreground font-medium mb-1">
                      <IconServer className="h-3.5 w-3.5 text-telnyx-green" /> MCP Server URL
                    </div>
                    <div className="break-all">{server.url}</div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-muted-foreground/20 bg-card">
              <CardContent className="p-6 space-y-3 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-telnyx-green/15 text-telnyx-green ring-1 ring-telnyx-green/25">
                    <IconInfoCircle className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-sm font-semibold">Description</div>
                    <div className="text-xs text-muted-foreground">Text exposed by the MCP server for this tool.</div>
                  </div>
                </div>
                {tool?.description ? (
                  <div className="rounded-xl border bg-background/60 p-4 text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {tool.description}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed bg-background/50 p-4 text-sm text-muted-foreground">No description provided by the MCP server.</div>
                )}
              </CardContent>
            </Card>

            {properties.length > 0 && (
              <Card className="border-muted-foreground/20 bg-card">
                <CardContent className="p-6 space-y-3 min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-telnyx-green/15 text-telnyx-green ring-1 ring-telnyx-green/25">
                        <IconBraces className="h-4 w-4" />
                      </span>
                      <div>
                        <div className="text-sm font-semibold">Input Arguments</div>
                        <div className="text-xs text-muted-foreground">Schema properties available for this tool.</div>
                      </div>
                    </div>
                    <Badge variant="secondary">{properties.length} fields</Badge>
                  </div>
                  <div className="space-y-2">
                    {properties.map((property) => (
                      <div key={property.name} className="rounded-xl border bg-background/60 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-foreground">{property.name}</span>
                          <Badge variant="outline" className="text-[10px]">{property.type}</Badge>
                          {property.required && <Badge className="border-transparent bg-red-500/15 text-red-700 dark:text-red-300 text-[10px]">required</Badge>}
                        </div>
                        {property.description && <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">{property.description}</div>}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            <JsonViewerCard title="Input Schema" icon={IconBraces} value={inputSchema} emptyLabel="No input schema provided." />
            <JsonViewerCard title="Output Schema" icon={IconBraces} value={outputSchema} emptyLabel="No output schema provided." />
            <JsonViewerCard title="Raw Tool Metadata" icon={IconCode} value={rawTool} />

            {objectKeys(inputSchema).length === 0 && !tool?.description && !outputSchema && (
              <Card className="border-dashed bg-card/60">
                <CardContent className="p-6 text-sm text-muted-foreground">
                  This MCP server did not expose additional metadata for this tool beyond its name.
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
