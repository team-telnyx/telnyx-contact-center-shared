"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoIcon, Loader2, CheckCircle, Copy } from "lucide-react";
import {
  CodeBlock as AICodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { notify } from "@/components/ToastNotify";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

export default function WidgetTab({
  values,
  setValues,
  assistantId,
  onAssistantUpdated,
  onWidgetStatusChange,
}) {
  const [widgetEnabled, setWidgetEnabled] = useState(
    values?.telephony?.supports_unauthenticated_web_calls || false
  );
  const [serverConfirmedWidgetEnabled, setServerConfirmedWidgetEnabled] =
    useState(values?.telephony?.supports_unauthenticated_web_calls || false);
  const [saving, setSaving] = useState(false);
  const [demoLinkOpen, setDemoLinkOpen] = useState(false);

  const demoLink = assistantId
    ? `https://portal.telnyx.com/#/ai-widget-demo?assistantId=${encodeURIComponent(assistantId)}`
    : "";

  const copyDemoLink = async () => {
    if (!demoLink) return;
    try {
      await navigator.clipboard.writeText(demoLink);
      notify({ title: "Demo link copied", variant: "success" });
    } catch (err) {
      console.error(err);
      notify({ title: "Failed to copy demo link", variant: "error" });
    }
  };

  const handleWidgetToggle = async (enabled) => {
    if (!assistantId) {
      notify({ title: "Assistant ID is required", variant: "error" });
      return;
    }

    setSaving(true);
    setWidgetEnabled(enabled);

    try {
      // Update local state immediately
      setValues((prev) => ({
        ...prev,
        telephony: {
          ...prev.telephony,
          supports_unauthenticated_web_calls: enabled,
        },
      }));

      // Save to server
      const payload = {
        telephony_settings: {
          ...values.telephony,
          supports_unauthenticated_web_calls: enabled,
        },
      };

      const res = await fetch(
        `/api/ai/assistants/${encodeURIComponent(assistantId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json();

      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Save failed");
      }

      // Only update server-confirmed status on successful response
      setServerConfirmedWidgetEnabled(enabled);

      // Notify parent about widget status change
      if (onWidgetStatusChange) {
        onWidgetStatusChange(enabled);
      }

      // Update parent component with the updated assistant data
      if (onAssistantUpdated && data?.assistant) {
        onAssistantUpdated(data.assistant);
      }

      notify({ title: enabled ? "Widget usage enabled" : "Widget usage disabled", variant: "success" });
    } catch (err) {
      console.error(err);
      // Revert the state on error
      setWidgetEnabled(!enabled);
      setServerConfirmedWidgetEnabled(!enabled);
      setValues((prev) => ({
        ...prev,
        telephony: {
          ...prev.telephony,
          supports_unauthenticated_web_calls: !enabled,
        },
      }));

      const message = err?.message || String(err) || "Save failed";
      notify({ title: `Failed to update widget settings: ${message}`, variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const widgetCode = `<telnyx-ai-agent agent-id="${assistantId}"></telnyx-ai-agent>
<script async="" src="https://unpkg.com/@telnyx/ai-agent-widget"></script>`;

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center space-x-2">
          <Switch
            id="widget-enabled"
            checked={widgetEnabled}
            onCheckedChange={handleWidgetToggle}
            disabled={saving}
          />
          <Label
            htmlFor="widget-enabled"
            className="text-sm font-medium flex items-center gap-2"
          >
            Enable Widget Usage
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          </Label>
        </div>

        {saving ? (
          <Alert variant="warning">
            <Loader2 className="h-4 w-4 animate-spin" />
            <AlertDescription>
              <strong>Updating widget settings...</strong> Please wait while we
              save your changes.
            </AlertDescription>
          </Alert>
        ) : serverConfirmedWidgetEnabled ? (
          <Alert variant="success">
            <CheckCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>Widget is enabled!</strong> Your AI assistant can now be
              embedded on websites. Users can interact with your assistant
              directly without requiring authentication.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="info">
            <InfoIcon className="h-4 w-4" />
            <AlertDescription>
              <strong>Widget Requirements:</strong> Widgets only work with
              assistants that have telephony enabled and support for
              unauthenticated web calls. This allows users to interact with your
              AI assistant directly from your website without requiring
              authentication.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {serverConfirmedWidgetEnabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Widget Integration Code</CardTitle>
            <CardDescription>
              Add this code to your website to enable the AI assistant widget.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <AICodeBlock code={widgetCode} language="html" showLineNumbers>
              <CodeBlockCopyButton />
            </AICodeBlock>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDemoLinkOpen(true)}
                disabled={!assistantId}
              >
                Copy Demo Link
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={demoLinkOpen} onOpenChange={setDemoLinkOpen}>
        <DialogContent className="sm:max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle className="text-2xl">
              Shareable AI Widget Demo Link
            </DialogTitle>
            <DialogDescription className="text-base leading-relaxed pt-2">
              Share this link to let anyone interact with your AI assistant
              through a widget demo. Users can experience your AI assistant
              without needing to log in or have a Telnyx account.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/50 p-3 overflow-hidden">
            <div
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm"
              title={demoLink}
            >
              {demoLink}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={copyDemoLink}
              aria-label="Copy demo link"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
            <Button type="button" onClick={copyDemoLink}>
              Copy URL
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Widget Configuration Card */}
      <Card className="mt-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Widget Configuration</CardTitle>
          <CardDescription>
            Customize the appearance and behavior of your AI assistant widget.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">

          {/* Row 1: Theme + Default State */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs font-medium">Theme</Label>
              <Select
                value={values?.widget_settings?.theme || "dark"}
                onValueChange={(val) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: { ...(v.widget_settings || {}), theme: val },
                  }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Default State</Label>
              <Select
                value={values?.widget_settings?.default_state || "collapsed"}
                onValueChange={(val) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: { ...(v.widget_settings || {}), default_state: val },
                  }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="collapsed">Collapsed</SelectItem>
                  <SelectItem value="expanded">Expanded</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Row 2: Position + Start Call Button Text */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs font-medium">Position</Label>
              <Select
                value={values?.widget_settings?.position || "fixed"}
                onValueChange={(val) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: { ...(v.widget_settings || {}), position: val },
                  }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fixed</SelectItem>
                  <SelectItem value="static">Static</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Start Call Button Text</Label>
              <Input
                value={values?.widget_settings?.start_call_text || ""}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: { ...(v.widget_settings || {}), start_call_text: e.target.value || undefined },
                  }))
                }
                placeholder="Start Call"
              />
            </div>
          </div>

          {/* Row 3: Agent Thinking Text + Speak to Interrupt Text */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs font-medium">Agent Thinking Text</Label>
              <Input
                value={values?.widget_settings?.agent_thinking_text || ""}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: { ...(v.widget_settings || {}), agent_thinking_text: e.target.value || undefined },
                  }))
                }
                placeholder="Thinking..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Speak to Interrupt Text</Label>
              <Input
                value={values?.widget_settings?.speak_to_interrupt_text || ""}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: { ...(v.widget_settings || {}), speak_to_interrupt_text: e.target.value || undefined },
                  }))
                }
                placeholder="Speak to interrupt"
              />
            </div>
          </div>

          {/* Row 4: Visualizer Color + Visualizer Preset */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs font-medium">Visualizer Color</Label>
              <Select
                value={values?.widget_settings?.audio_visualizer_config?.color || "verdant"}
                onValueChange={(val) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: {
                      ...(v.widget_settings || {}),
                      audio_visualizer_config: {
                        ...(v.widget_settings?.audio_visualizer_config || {}),
                        color: val,
                      },
                    },
                  }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="verdant">Verdant</SelectItem>
                  <SelectItem value="twilight">Twilight</SelectItem>
                  <SelectItem value="bloom">Bloom</SelectItem>
                  <SelectItem value="mystic">Mystic</SelectItem>
                  <SelectItem value="flare">Flare</SelectItem>
                  <SelectItem value="glacier">Glacier</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Visualizer Preset</Label>
              <Select
                value={values?.widget_settings?.audio_visualizer_config?.preset || "round_bars"}
                onValueChange={(val) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: {
                      ...(v.widget_settings || {}),
                      audio_visualizer_config: {
                        ...(v.widget_settings?.audio_visualizer_config || {}),
                        preset: val,
                      },
                    },
                  }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="round_bars">Round Bars</SelectItem>
                  <SelectItem value="line">Line</SelectItem>
                  <SelectItem value="circle">Circle</SelectItem>
                  <SelectItem value="scattered_dots">Scattered Dots</SelectItem>
                  <SelectItem value="frequency_bands">Frequency Bands</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Separator for URLs section */}
          <Separator />

          {/* Row 5: Logo Icon URL + View History URL */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs font-medium">Logo Icon URL</Label>
              <Input
                value={values?.widget_settings?.logo_icon_url || ""}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: { ...(v.widget_settings || {}), logo_icon_url: e.target.value || null },
                  }))
                }
                placeholder="https://example.com/logo.png"
                type="url"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">View History URL</Label>
              <Input
                value={values?.widget_settings?.view_history_url || ""}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: { ...(v.widget_settings || {}), view_history_url: e.target.value || null },
                  }))
                }
                placeholder="https://example.com/history"
                type="url"
              />
            </div>
          </div>

          {/* Row 6: Report Issue URL + Give Feedback URL */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs font-medium">Report Issue URL</Label>
              <Input
                value={values?.widget_settings?.report_issue_url || ""}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: { ...(v.widget_settings || {}), report_issue_url: e.target.value || null },
                  }))
                }
                placeholder="https://example.com/report"
                type="url"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Give Feedback URL</Label>
              <Input
                value={values?.widget_settings?.give_feedback_url || ""}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    widget_settings: { ...(v.widget_settings || {}), give_feedback_url: e.target.value || null },
                  }))
                }
                placeholder="https://example.com/feedback"
                type="url"
              />
            </div>
          </div>

        </CardContent>
      </Card>
    </div>
  );
}
