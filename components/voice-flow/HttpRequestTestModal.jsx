"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  IconX,
  IconFlask,
  IconLoader2,
  IconCheck,
  IconAlertCircle,
  IconCode,
  IconCopy,
  IconExternalLink,
  IconWorld,
  IconSettings,
  IconVariable,
  IconEye,
  IconChevronRight,
} from "@tabler/icons-react";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * HTTP Request Test Modal
 * A sheet that slides in from the right to test HTTP requests with variable substitution
 */
export default function HttpRequestTestModal({
  open,
  onOpenChange,
  config,
  availableVariables = [],
  onTestSuccess,
}) {
  const [testVariables, setTestVariables] = useState({});
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState(null);
  const [variablesExpanded, setVariablesExpanded] = useState(true);
  const [requestExpanded, setRequestExpanded] = useState(true);

  // Extract variables used in the configuration
  const extractUsedVariables = () => {
    const variables = new Set();
    const configStr = JSON.stringify(config);

    // Find all {{variable}} patterns
    const matches = configStr.match(/\{\{([^}]+)\}\}/g);
    if (matches) {
      matches.forEach((match) => {
        const varName = match.replace(/\{\{|\}\}/g, "").trim();
        // Remove prefixes like payload., response., etc.
        const cleanVar = varName.replace(
          /^(payload\.|response\.|global\.)/,
          ""
        );
        // Filter out integration_secret and other system variables
        if (
          cleanVar &&
          !cleanVar.includes(".") &&
          !cleanVar.includes("integration_secret") &&
          !cleanVar.includes("#") &&
          !cleanVar.includes("/")
        ) {
          variables.add(cleanVar);
        }
      });
    }

    return Array.from(variables);
  };

  const usedVariables = extractUsedVariables();

  // Initialize test variables with empty values
  useEffect(() => {
    if (open && usedVariables.length > 0) {
      const initialVars = {};
      usedVariables.forEach((varName) => {
        if (!(varName in testVariables)) {
          initialVars[varName] = "";
        }
      });
      if (Object.keys(initialVars).length > 0) {
        setTestVariables((prev) => ({ ...prev, ...initialVars }));
      }
    }
  }, [open, usedVariables]);

  const handleVariableChange = (varName, value) => {
    setTestVariables((prev) => ({
      ...prev,
      [varName]: value,
    }));
  };

  const substituteVariables = (text) => {
    if (!text || typeof text !== "string") return text;

    return text.replace(/\{\{([^}]+)\}\}/g, (match, varPath) => {
      const trimmedPath = varPath.trim();

      // Handle prefixes
      if (trimmedPath.startsWith("payload.")) {
        const path = trimmedPath.substring(8);
        return testVariables[path] || match;
      }
      if (trimmedPath.startsWith("response.")) {
        const path = trimmedPath.substring(9);
        return testVariables[path] || match;
      }
      if (trimmedPath.startsWith("global.")) {
        const path = trimmedPath.substring(7);
        return testVariables[path] || match;
      }

      // Direct variable access
      return testVariables[trimmedPath] || match;
    });
  };

  const buildTestConfig = () => {
    const substitutedConfig = {
      url: substituteVariables(config.url || ""),
      method: config.method || "GET",
      headers: {},
      pathParams: {},
      queryParams: {},
      body: config.body || "",
      timeout: config.timeout || 30000,
    };

    // Process headers
    Object.entries(config.headers || {}).forEach(([key, value]) => {
      substitutedConfig.headers[key] = substituteVariables(value);
    });

    // Process path parameters
    Object.entries(config.pathParams || {}).forEach(([key, value]) => {
      substitutedConfig.pathParams[key] = substituteVariables(value);
    });

    // Process query parameters
    Object.entries(config.queryParams || {}).forEach(([key, value]) => {
      substitutedConfig.queryParams[key] = substituteVariables(value);
    });

    // Process body parameters if using params mode
    if (config.bodyType === "params" && config.bodyParams) {
      const bodyParams = {};
      Object.entries(config.bodyParams).forEach(([key, value]) => {
        bodyParams[key] = substituteVariables(value);
      });
      substitutedConfig.body = JSON.stringify(bodyParams);
    } else if (config.bodyType === "json") {
      substitutedConfig.body = substituteVariables(config.body || "");
    }

    return substitutedConfig;
  };

  const handleTestRequest = async () => {
    setIsTesting(true);
    setTestError(null);
    setTestResult(null);

    try {
      const testConfig = buildTestConfig();

      const response = await fetch("/api/voice/flows/test-http-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(testConfig),
      });

      const responseText = await response.text();
      const result = responseText.trim()
        ? JSON.parse(responseText)
        : { success: false, error: "Test endpoint returned an empty response" };

      if (!response.ok) {
        setTestError(result.error || "Test request failed");
        return;
      }

      if (result.success) {
        setTestResult(result.response);
        onTestSuccess?.(result.response);
      } else {
        setTestError(result.error || "Request failed");
      }
    } catch (error) {
      console.error("Test request error:", error);
      setTestError(error.message || "Failed to test request");
    } finally {
      setIsTesting(false);
    }
  };

  const getStatusBadge = (status) => {
    if (status >= 200 && status < 300) {
      return (
        <Badge
          variant="secondary"
          className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
        >
          <IconCheck className="h-3 w-3 mr-1" />
          {status} OK
        </Badge>
      );
    } else if (status >= 400) {
      return (
        <Badge
          variant="secondary"
          className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
        >
          <IconAlertCircle className="h-3 w-3 mr-1" />
          {status} Error
        </Badge>
      );
    } else {
      return (
        <Badge
          variant="secondary"
          className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
        >
          {status} Info
        </Badge>
      );
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <IconFlask className="h-4 w-4 text-telnyx-green" />
            Test HTTP Request
          </SheetTitle>
          <SheetDescription className="text-sm">
            Test your HTTP request configuration with variable substitution
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 space-y-4">
          {/* Variable Substitution Section */}
          {usedVariables.length > 0 && (
            <Card className="border border-border bg-card">
              <Collapsible
                open={variablesExpanded}
                onOpenChange={setVariablesExpanded}
              >
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors p-3">
                    <div className="flex items-center gap-2">
                      <IconVariable className="h-3 w-3 text-blue-600" />
                      <CardTitle className="text-sm font-semibold">
                        Variable Values
                      </CardTitle>
                      <Badge variant="secondary" className="ml-auto text-xs">
                        {usedVariables.length}
                      </Badge>
                      <IconChevronRight
                        className={`h-3 w-3 transition-transform ${
                          variablesExpanded ? "rotate-90" : ""
                        }`}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Provide values for variables used in your request
                    </p>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="px-3 pb-3 space-y-3">
                    {usedVariables.map((varName) => (
                      <div key={varName} className="space-y-1">
                        <Label className="text-xs font-medium flex items-center gap-1">
                          <IconVariable className="h-3 w-3" />
                          {varName}
                        </Label>
                        <Input
                          value={testVariables[varName] || ""}
                          onChange={(e) =>
                            handleVariableChange(varName, e.target.value)
                          }
                          placeholder={`Enter value for ${varName}`}
                          className="text-xs h-8"
                        />
                      </div>
                    ))}
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          )}

          {/* Request Preview */}
          <Card className="border border-border bg-card">
            <Collapsible
              open={requestExpanded}
              onOpenChange={setRequestExpanded}
            >
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors p-3">
                  <div className="flex items-center gap-2">
                    <IconEye className="h-3 w-3 text-green-600" />
                    <CardTitle className="text-sm font-semibold">
                      Request Preview
                    </CardTitle>
                    <IconChevronRight
                      className={`h-3 w-3 transition-transform ${
                        requestExpanded ? "rotate-90" : ""
                      }`}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    How your request will look with variable substitution
                  </p>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="px-3 pb-3 space-y-4">
                  {/* URL */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <IconWorld className="h-3 w-3 text-blue-600" />
                      <Label className="text-xs font-medium">URL</Label>
                    </div>
                    <div className="p-3 bg-muted/50 rounded border">
                      <code className="text-xs font-mono break-all text-foreground">
                        {substituteVariables(config.url || "")}
                      </code>
                    </div>
                  </div>

                  {/* Method */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <IconSettings className="h-3 w-3 text-purple-600" />
                      <Label className="text-xs font-medium">Method</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs px-2 py-1">
                        {config.method || "GET"}
                      </Badge>
                    </div>
                  </div>

                  {/* Headers */}
                  {Object.keys(config.headers || {}).length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <IconSettings className="h-3 w-3 text-orange-600" />
                        <Label className="text-xs font-medium">Headers</Label>
                        <Badge variant="secondary" className="text-xs">
                          {Object.keys(config.headers || {}).length}
                        </Badge>
                      </div>
                      <div className="space-y-2">
                        {Object.entries(config.headers || {}).map(
                          ([key, value]) => (
                            <div
                              key={key}
                              className="p-2 bg-muted/50 rounded border"
                            >
                              <div className="flex items-start gap-2">
                                <Badge
                                  variant="outline"
                                  className="min-w-0 flex-shrink-0 text-telnyx-green border-telnyx-green/40 bg-telnyx-green/10 font-mono text-[11px]"
                                >
                                  {key}:
                                </Badge>
                                <code className="text-xs text-muted-foreground break-all">
                                  {substituteVariables(value)}
                                </code>
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Path Parameters */}
                  {Object.keys(config.pathParams || {}).length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <IconVariable className="h-3 w-3 text-cyan-600" />
                        <Label className="text-xs font-medium">
                          Path Parameters
                        </Label>
                        <Badge variant="secondary" className="text-xs">
                          {Object.keys(config.pathParams || {}).length}
                        </Badge>
                      </div>
                      <div className="space-y-2">
                        {Object.entries(config.pathParams || {}).map(
                          ([key, value]) => (
                            <div
                              key={key}
                              className="p-2 bg-muted/50 rounded border"
                            >
                              <div className="flex items-start gap-2">
                                <Badge
                                  variant="outline"
                                  className="min-w-0 flex-shrink-0 text-telnyx-green border-telnyx-green/40 bg-telnyx-green/10 font-mono text-[11px]"
                                >
                                  {key}:
                                </Badge>
                                <code className="text-xs text-muted-foreground break-all">
                                  {substituteVariables(value)}
                                </code>
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Query Parameters */}
                  {Object.keys(config.queryParams || {}).length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <IconSettings className="h-3 w-3 text-indigo-600" />
                        <Label className="text-xs font-medium">
                          Query Parameters
                        </Label>
                        <Badge variant="secondary" className="text-xs">
                          {Object.keys(config.queryParams || {}).length}
                        </Badge>
                      </div>
                      <div className="space-y-2">
                        {Object.entries(config.queryParams || {}).map(
                          ([key, value]) => (
                            <div
                              key={key}
                              className="p-2 bg-muted/50 rounded border"
                            >
                              <div className="flex items-start gap-2">
                                <Badge
                                  variant="outline"
                                  className="min-w-0 flex-shrink-0 text-telnyx-green border-telnyx-green/40 bg-telnyx-green/10 font-mono text-[11px]"
                                >
                                  {key}:
                                </Badge>
                                <code className="text-xs text-muted-foreground break-all">
                                  {substituteVariables(value)}
                                </code>
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>

          {/* Test Button */}
          <Button
            onClick={handleTestRequest}
            disabled={isTesting}
            className="w-full"
            size="sm"
          >
            {isTesting ? (
              <>
                <IconLoader2 className="h-3 w-3 mr-2 animate-spin" />
                Testing Request...
              </>
            ) : (
              <>
                <IconFlask className="h-3 w-3 mr-2" />
                Test Request
              </>
            )}
          </Button>

          {/* Error Display */}
          {testError && (
            <Card className="border-red-200 dark:border-red-800 bg-card">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 text-red-800 dark:text-red-200">
                  <IconAlertCircle className="h-3 w-3" />
                  <span className="text-xs font-medium">Test Failed</span>
                </div>
                <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                  {testError}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Response Display */}
          {testResult && (
            <Card className="border border-border bg-card">
              <CardHeader className="p-3">
                <div className="flex items-center gap-2">
                  <IconCode className="h-3 w-3 text-green-600" />
                  <CardTitle className="text-sm font-semibold">Response</CardTitle>
                  <div className="ml-auto">{getStatusBadge(testResult.status)}</div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Response data from the test request
                </p>
              </CardHeader>
              <CardContent className="px-3 pb-3 space-y-4">
                <div>
                  <Label className="text-xs font-medium flex items-center gap-2 mb-2">
                    <IconCode className="h-3 w-3" />
                    Response Body
                  </Label>
                  <CodeBlock
                    code={JSON.stringify(testResult.body, null, 2)}
                    language="json"
                  >
                    <CodeBlockCopyButton />
                  </CodeBlock>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
