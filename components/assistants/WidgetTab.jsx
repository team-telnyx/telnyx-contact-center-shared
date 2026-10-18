"use client";
import AssistantWidgetSettings from "./AssistantWidgetSettings";
import { useUiText } from "@/components/i18n/use-ui-text";


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
  draftMode = false,
  appearanceOnly = false,
  section = "all",
}) {
  const tUi = useUiText();
  const [savedWidgetEnabled, setWidgetEnabled] = useState(
    values?.telephony?.supports_unauthenticated_web_calls || false
  );
  const [confirmedWidgetEnabled, setServerConfirmedWidgetEnabled] =
    useState(values?.telephony?.supports_unauthenticated_web_calls || false);
  const widgetEnabled = draftMode ? Boolean(values?.telephony?.supports_unauthenticated_web_calls) : savedWidgetEnabled;
  const serverConfirmedWidgetEnabled = draftMode ? Boolean(values?._original?.telephony_settings?.supports_unauthenticated_web_calls) : confirmedWidgetEnabled;
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
    if (draftMode) {
      setWidgetEnabled(enabled);
      setValues(prev=>({...prev,telephony:{...prev.telephony,supports_unauthenticated_web_calls:enabled},enabled_features:enabled?[...new Set([...(prev.enabled_features||[]),'telephony'])]:prev.enabled_features}));
      return;
    }
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

      if (!res.ok || data?.ok === false || data.verification?.status !== "verified") {
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
      notify({ title: tUi("Failed to update widget settings: {value0}", {value0: message}), variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const widgetCode = `<telnyx-ai-agent agent-id="${assistantId}"></telnyx-ai-agent>
<script async="" src="https://unpkg.com/@telnyx/ai-agent-widget"></script>`;

  if (section === "behavior") return <AssistantWidgetSettings values={values} setValues={setValues} section="behavior"/>;

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
          >{tUi("Enable Widget Usage")}{saving && <Loader2 className="h-4 w-4 animate-spin" />}
          </Label>
        </div>

        {draftMode && widgetEnabled !== serverConfirmedWidgetEnabled ? <p className="text-sm text-muted-foreground">{tUi("Save the assistant to apply the widget access change.")}</p> : saving ? (
          <Alert variant="warning">
            <Loader2 className="h-4 w-4 animate-spin" />
            <AlertDescription>
              <strong>{tUi("Updating widget settings...")}</strong>{tUi(" Please wait while we save your changes.")}</AlertDescription>
          </Alert>
        ) : serverConfirmedWidgetEnabled ? (
          <Alert variant="success">
            <CheckCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>{tUi("Widget is enabled!")}</strong>{tUi(" Your AI assistant can now be embedded on websites. Users can interact with your assistant directly without requiring authentication.")}</AlertDescription>
          </Alert>
        ) : (
          <Alert variant="info">
            <InfoIcon className="h-4 w-4" />
            <AlertDescription>
              <strong>{tUi("Widget Requirements:")}</strong>{tUi(" Widgets only work with assistants that have telephony enabled and support for unauthenticated web calls. This allows users to interact with your AI assistant directly from your website without requiring authentication.")}</AlertDescription>
          </Alert>
        )}
      </div>

      {serverConfirmedWidgetEnabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{tUi("Widget Integration Code")}</CardTitle>
            <CardDescription>{tUi("Add this code to your website to enable the AI assistant widget.")}</CardDescription>
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
              >{tUi("Copy Demo Link")}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={demoLinkOpen} onOpenChange={setDemoLinkOpen}>
        <DialogContent className="sm:max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle className="text-2xl">{tUi("Shareable AI Widget Demo Link")}</DialogTitle>
            <DialogDescription className="text-base leading-relaxed pt-2">{tUi("Share this link to let anyone interact with your AI assistant through a widget demo. Users can experience your AI assistant without needing to log in or have a Telnyx account.")}</DialogDescription>
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
              aria-label={tUi("Copy demo link")}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{tUi("Close")}</Button>
            </DialogClose>
            <Button type="button" onClick={copyDemoLink}>{tUi("Copy URL")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!appearanceOnly ? <AssistantWidgetSettings values={values} setValues={setValues} section={section}/> : null}
    </div>
  );
}
