"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import {
  IconAlertCircle,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconDatabase,
  IconEye,
  IconFlask,
  IconLoader2,
  IconMessage2,
  IconVariable,
} from "@tabler/icons-react";
import { buildMcpToolArguments } from "@/lib/mcp/mcp-argument-builder";

function extractUsedVariables(config = {}) {
  const variables = new Set();
  const matches = JSON.stringify(config).match(/\{\{([^}]+)\}\}/g);
  matches?.forEach((match) => {
    const name = match.replace(/\{\{|\}\}/g, "").trim();
    if (name && !name.includes("#") && !name.includes("/")) variables.add(name);
  });
  return Array.from(variables);
}

function buildRequestPreview(config = {}) {
  let argumentsPreview;
  try {
    argumentsPreview = buildMcpToolArguments({
      input: config.input,
      instruction: config.instruction,
      toolName: config.toolName,
      toolInputSchema: config.toolInputSchema,
    });
  } catch (error) {
    argumentsPreview = { error: error.message || "Invalid advanced JSON input" };
  }

  return Object.fromEntries(
    Object.entries({
      serverId: config.serverId,
      toolName: config.toolName,
      instruction: config.instruction,
      arguments: argumentsPreview,
      responseVariable: config.responseVariable || "mcp_response",
    }).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

export default function McpToolTestSheet({
  open,
  onOpenChange,
  config = {},
  selectedServer = null,
  selectedTool = null,
  onTestSuccess,
}) {
  const [testVariables, setTestVariables] = useState({});
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState(null);
  const [variablesExpanded, setVariablesExpanded] = useState(true);
  const [requestExpanded, setRequestExpanded] = useState(true);
  const [responseExpanded, setResponseExpanded] = useState(true);

  const usedVariables = useMemo(() => extractUsedVariables(config), [config]);
  const requestPreview = useMemo(() => buildRequestPreview(config), [config]);

  useEffect(() => {
    if (!open) return;
    setTestVariables((prev) => {
      const next = { ...prev };
      usedVariables.forEach((variable) => {
        if (!(variable in next)) next[variable] = "";
      });
      return next;
    });
  }, [open, usedVariables]);

  const handleTest = async () => {
    setIsTesting(true);
    setTestError(null);
    setTestResult(null);
    const configAtTestStart = config;

    try {
      const response = await fetch("/api/voice/flows/test-mcp-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, testVariables }),
      });
      const result = await response.json();
      if (result.response) setTestResult(result.response);
      if (!response.ok || !result.success) {
        setTestError(result.error || "MCP Tool test failed");
        return;
      }
      onTestSuccess?.(result.response, configAtTestStart);
    } catch (error) {
      setTestError(error.message || "Failed to test MCP Tool");
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <IconFlask className="h-4 w-4 text-telnyx-green" />
            Test MCP Tool
          </SheetTitle>
          <SheetDescription className="text-sm">
            Test the selected MCP tool with variable substitution and inspect the response structure.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 space-y-4">
          {usedVariables.length > 0 && (
            <Card className="border border-border bg-card">
              <Collapsible open={variablesExpanded} onOpenChange={setVariablesExpanded}>
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors p-3">
                    <div className="flex items-center gap-2">
                      <IconVariable className="h-3 w-3 text-blue-600" />
                      <CardTitle className="text-sm font-semibold">Variable Values</CardTitle>
                      <Badge variant="secondary" className="ml-auto text-xs">{usedVariables.length}</Badge>
                      <IconChevronRight className={`h-3 w-3 transition-transform ${variablesExpanded ? "rotate-90" : ""}`} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Provide sample values for variables in this MCP instruction.</p>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="px-3 pb-3 space-y-3">
                    {usedVariables.map((variable) => (
                      <div key={variable} className="space-y-1">
                        <Label className="text-xs font-medium flex items-center gap-1">
                          <IconVariable className="h-3 w-3" />
                          {variable}
                        </Label>
                        <Input
                          value={testVariables[variable] || ""}
                          onChange={(event) => setTestVariables((prev) => ({ ...prev, [variable]: event.target.value }))}
                          placeholder={`Enter value for ${variable}`}
                          className="text-xs h-8"
                        />
                      </div>
                    ))}
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          )}

          <Card className="border border-border bg-card">
            <Collapsible open={requestExpanded} onOpenChange={setRequestExpanded}>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors p-3">
                  <div className="flex items-center gap-2">
                    <IconEye className="h-3 w-3 text-green-600" />
                    <CardTitle className="text-sm font-semibold">Request Preview</CardTitle>
                    <IconChevronRight className={`h-3 w-3 ml-auto transition-transform ${requestExpanded ? "rotate-90" : ""}`} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Server, tool, and arguments sent to MCP.</p>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="px-3 pb-3 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 bg-muted/50 rounded border">
                      <Label className="text-xs text-muted-foreground">MCP Server</Label>
                      <div className="text-sm font-medium mt-1">{selectedServer?.name || config.serverId || "Not selected"}</div>
                    </div>
                    <div className="p-3 bg-muted/50 rounded border">
                      <Label className="text-xs text-muted-foreground">Tool</Label>
                      <div className="text-sm font-medium mt-1">{selectedTool?.name || config.toolName || "Not selected"}</div>
                    </div>
                  </div>
                  <CodeBlock code={JSON.stringify(requestPreview, null, 2)} language="json" showLineNumbers maxHeight={320} className="max-h-80 overflow-auto">
                    <CodeBlockCopyButton type="button" />
                  </CodeBlock>
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>

          <Button onClick={handleTest} disabled={isTesting || !config.serverId || !config.toolName || (!config.instruction && !config.input)} className="w-full" size="sm">
            {isTesting ? (
              <>
                <IconLoader2 className="h-3 w-3 mr-2 animate-spin" />
                Testing Tool...
              </>
            ) : (
              <>
                <IconFlask className="h-3 w-3 mr-2" />
                Test Tool
              </>
            )}
          </Button>

          {testError && (
            <Card className="border-red-200 dark:border-red-800 bg-card">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 text-red-800 dark:text-red-200">
                  <IconAlertCircle className="h-3 w-3" />
                  <span className="text-xs font-medium">Test Failed</span>
                </div>
                <p className="text-xs text-red-700 dark:text-red-300 mt-1">{testError}</p>
              </CardContent>
            </Card>
          )}

          {testResult && (
            <Card className="border border-border bg-card">
              <Collapsible open={responseExpanded} onOpenChange={setResponseExpanded}>
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors p-3">
                    <div className="flex items-center gap-2">
                      <IconDatabase className="h-3 w-3 text-green-600" />
                      <CardTitle className="text-sm font-semibold">Response Structure</CardTitle>
                      <div className="ml-auto flex items-center gap-2">
                        {testResult.isError ? (
                          <Badge variant="secondary" className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
                            <IconAlertCircle className="h-3 w-3 mr-1" /> Error
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                            <IconCheck className="h-3 w-3 mr-1" /> Success
                          </Badge>
                        )}
                        <IconChevronRight className={`h-3 w-3 transition-transform ${responseExpanded ? "rotate-90" : ""}`} />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Normalized MCP response saved to the response variable.</p>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="px-3 pb-3 space-y-4">
                    {testResult.text && (
                      <div>
                        <Label className="text-xs font-medium flex items-center gap-2 mb-2">
                          <IconMessage2 className="h-3 w-3" />
                          Response Text
                        </Label>
                        <div className="rounded border bg-muted/50 p-3 text-xs whitespace-pre-wrap">{testResult.text}</div>
                      </div>
                    )}
                    <div>
                      <Label className="text-xs font-medium flex items-center gap-2 mb-2">
                        <IconCode className="h-3 w-3" />
                        Response JSON
                      </Label>
                      <CodeBlock code={JSON.stringify(testResult, null, 2)} language="json" showLineNumbers maxHeight={384} className="max-h-96 overflow-auto">
                        <CodeBlockCopyButton type="button" />
                      </CodeBlock>
                    </div>
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
