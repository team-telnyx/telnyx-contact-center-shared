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
  IconVariable,
} from "@tabler/icons-react";

function buildRequestPreview(config = {}) {
  const {
    action,
    dataSource,
    fields,
    queryParams,
    recordId,
    responseVariable,
  } = config || {};

  return Object.fromEntries(
    Object.entries({
      responseVariable,
      dataSource,
      fields: fields || {},
      queryParams: queryParams || {},
      recordId,
      action,
    }).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function extractUsedVariables(config = {}) {
  const variables = new Set();
  const matches = JSON.stringify(config).match(/\{\{([^}]+)\}\}/g);
  matches?.forEach((match) => {
    const varName = match.replace(/\{\{|\}\}/g, "").trim();
    if (varName && !varName.includes("#") && !varName.includes("/")) {
      variables.add(varName);
    }
  });
  return Array.from(variables);
}

export default function DataActionTestSheet({
  open,
  onOpenChange,
  config = {},
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
      const response = await fetch("/api/voice/flows/test-data-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, testVariables }),
      });
      const result = await response.json();

      if (result.response) {
        setTestResult(result.response);
      }
      if (!response.ok || !result.success) {
        setTestError(result.error || "Data Action test failed");
        return;
      }
      onTestSuccess?.(result.response, configAtTestStart);
    } catch (error) {
      setTestError(error.message || "Failed to test Data Action");
    } finally {
      setIsTesting(false);
    }
  };

  const getStatusBadge = (status) => {
    if (status >= 200 && status < 300) {
      return (
        <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
          <IconCheck className="h-3 w-3 mr-1" />
          {status} OK
        </Badge>
      );
    }
    if (status >= 400) {
      return (
        <Badge variant="secondary" className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
          <IconAlertCircle className="h-3 w-3 mr-1" />
          {status} Error
        </Badge>
      );
    }
    return <Badge variant="secondary">{status}</Badge>;
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <IconFlask className="h-4 w-4 text-telnyx-green" />
            Test Data Action
          </SheetTitle>
          <SheetDescription className="text-sm">
            Test your Data Action configuration with variable substitution
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
                    <p className="text-xs text-muted-foreground mt-1">
                      Provide values for variables used in this Data Action
                    </p>
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
                  <p className="text-xs text-muted-foreground mt-1">
                    Data source, action, fields, and query parameters that will be tested
                  </p>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="px-3 pb-3 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 bg-muted/50 rounded border">
                      <Label className="text-xs text-muted-foreground">Data Source</Label>
                      <div className="text-sm font-medium mt-1">{config.dataSource || "Not selected"}</div>
                    </div>
                    <div className="p-3 bg-muted/50 rounded border">
                      <Label className="text-xs text-muted-foreground">Action</Label>
                      <div className="text-sm font-medium mt-1">{config.action || "Not selected"}</div>
                    </div>
                  </div>
                  <CodeBlock
                    code={JSON.stringify(requestPreview, null, 2)}
                    language="json"
                    showLineNumbers
                    maxHeight={320}
                    className="max-h-80 overflow-auto"
                  >
                    <CodeBlockCopyButton type="button" />
                  </CodeBlock>
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>

          <Button onClick={handleTest} disabled={isTesting || !config.dataSource || !config.action} className="w-full" size="sm">
            {isTesting ? (
              <>
                <IconLoader2 className="h-3 w-3 mr-2 animate-spin" />
                Testing Data Action...
              </>
            ) : (
              <>
                <IconFlask className="h-3 w-3 mr-2" />
                Test Data Action
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
                      <CardTitle className="text-sm font-semibold">Response</CardTitle>
                      <div className="ml-auto flex items-center gap-2">
                        {getStatusBadge(testResult.status)}
                        <IconChevronRight className={`h-3 w-3 transition-transform ${responseExpanded ? "rotate-90" : ""}`} />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Response data from the Data Action test
                    </p>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="px-3 pb-3 space-y-4">
                    <div>
                      <Label className="text-xs font-medium flex items-center gap-2 mb-2">
                        <IconCode className="h-3 w-3" />
                        Response Body
                      </Label>
                      <CodeBlock
                        code={JSON.stringify(testResult.body, null, 2)}
                        language="json"
                        showLineNumbers
                        maxHeight={384}
                        className="max-h-96 overflow-auto"
                      >
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
