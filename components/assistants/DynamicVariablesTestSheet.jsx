"use client";

import { useState, useEffect } from "react";
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
import {
  IconFlask,
  IconLoader2,
  IconCheck,
  IconAlertCircle,
  IconSettings,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";

/**
 * Dynamic Variables Test Sheet
 * A sheet that slides in from the right to test dynamic variables webhook
 */
export default function DynamicVariablesTestSheet({
  open,
  onOpenChange,
  webhookUrl,
  entries = [],
}) {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState(null);
  const [endUserTarget, setEndUserTarget] = useState("");

  // Fetch user profile to get mobile phone as default value
  useEffect(() => {
    if (open) {
      (async () => {
        try {
          const res = await fetch("/api/auth/me", { cache: "no-store" });
          const data = await res.json();
          const mobile = data?.user?.mobile || "";
          if (mobile) {
            setEndUserTarget(mobile);
          } else {
            setEndUserTarget("+15551234567"); // Fallback default
          }
        } catch (err) {
          console.error("Failed to fetch user profile:", err);
          setEndUserTarget("+15551234567"); // Fallback default
        }
      })();
    }
  }, [open]);

  const handleTestRequest = async () => {
    setIsTesting(true);
    setTestError(null);
    setTestResult(null);

    try {
      // Build the payload in the required format
      const payload = {
        data: {
          record_type: "event",
          id: `event_${crypto.randomUUID()}`,
          event_type: "assistant.initialization",
          occurred_at: new Date().toISOString(),
          payload: {
            telnyx_conversation_channel: "phone_call",
            telnyx_agent_target: "+13128675309",
            telnyx_end_user_target: endUserTarget,
            telnyx_end_user_target_verified: false,
            call_control_id: "v3:u5OAKGEPT3Dx8SZSSDRWEMdNH2OripQhO",
            assistant_id: "assistant_12345678-90ab-cdef-1234-567890abcdef",
          },
        },
      };

      const response = await fetch("/api/assistants/test-dynamic-variables", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: webhookUrl,
          payload,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setTestError(result.error || "Test request failed");
        return;
      }

      if (result.success) {
        setTestResult(result.response);
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

  if (!webhookUrl) {
    return null;
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[600px] sm:w-[700px] overflow-y-auto mb-4">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <IconFlask className="h-5 w-5 text-blue-500" />
            Test Dynamic Variables Webhook
          </SheetTitle>
          <SheetDescription>
            Test your dynamic variables webhook with sample data
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 mt-0 mx-4">
          {/* Request Configuration */}
          <Card>
            <CardHeader className="pb-0">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <IconSettings className="h-4 w-4" />
                  Request Configuration
                </CardTitle>
                <Button
                  onClick={handleTestRequest}
                  disabled={isTesting}
                  size="sm"
                  className="ml-auto"
                >
                  {isTesting ? (
                    <>
                      <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                      Testing...
                    </>
                  ) : (
                    <>
                      <IconFlask className="h-4 w-4 mr-2" />
                      Test
                    </>
                  )}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs">Webhook URL</Label>
                <div className="mt-1 px-3 py-2 bg-muted rounded-md text-sm font-mono break-all">
                  {webhookUrl}
                </div>
              </div>

              {/* End User Target Parameter */}
              <div>
                <Label className="text-xs">End User Target</Label>
                <div className="space-y-2 mt-2">
                  <div>
                    <Input
                      value={endUserTarget}
                      onChange={(e) => setEndUserTarget(e.target.value)}
                      placeholder="Enter phone number (e.g., +15551234567)"
                      className="mt-1"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Test Results */}
          {testError && (
            <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                  <IconAlertCircle className="h-4 w-4" />
                  <span className="font-medium">Test Failed</span>
                </div>
                <p className="text-sm text-red-600 dark:text-red-400 mt-2">
                  {testError}
                </p>
              </CardContent>
            </Card>
          )}

          {testResult && (
            <Card className="mb-4">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <IconCheck className="h-4 w-4 text-green-500" />
                  Test Response
                  {getStatusBadge(testResult.status)}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-4">
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Content Type
                    </Label>
                    <div className="mt-1 px-3 py-2 bg-muted rounded-md text-sm font-mono">
                      {testResult.content_type || "application/json"}
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Response Body
                    </Label>
                    <div className="mt-2 border rounded-md h-[500px] overflow-y-auto">
                      <CodeBlock
                        language="json"
                        code={
                          typeof testResult.body === "string"
                            ? (() => {
                                try {
                                  return JSON.stringify(
                                    JSON.parse(testResult.body),
                                    null,
                                    2
                                  );
                                } catch {
                                  return testResult.body;
                                }
                              })()
                            : JSON.stringify(testResult.body || {}, null, 2)
                        }
                      >
                        <CodeBlockCopyButton />
                      </CodeBlock>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
