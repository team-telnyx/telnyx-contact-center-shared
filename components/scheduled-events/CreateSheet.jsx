"use client";

import React from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { IconPlus } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/components/auth-provider";

/**
 * Create sheet component for Scheduled Events
 * @param {object} props
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 * @param {array} props.assistants - List of available AI assistants
 * @param {function} props.onSaveComplete - Callback when save is complete
 * @param {string} props.preselectedAssistantId - Optional preselected assistant ID
 */
export default function CreateSheet({
  open,
  onOpenChange,
  assistants = [],
  onSaveComplete,
  preselectedAssistantId = "",
}) {
  const { user } = useAuth();
  const [assistantId, setAssistantId] = React.useState(
    preselectedAssistantId || "",
  );
  const [channel, setChannel] = React.useState("phone_call");
  const [fromNumber, setFromNumber] = React.useState("");
  const [toNumber, setToNumber] = React.useState("");
  const [scheduledAt, setScheduledAt] = React.useState("");
  const [maxRetriesClientErrors, setMaxRetriesClientErrors] =
    React.useState("0");
  const [retryIntervalSecs, setRetryIntervalSecs] = React.useState("");
  const [text, setText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [phoneNumbers, setPhoneNumbers] = React.useState([]);
  const [loadingNumbers, setLoadingNumbers] = React.useState(false);

  // Load phone numbers when assistant is selected
  React.useEffect(() => {
    async function loadPhoneNumbers() {
      if (!assistantId) {
        setPhoneNumbers([]);
        setFromNumber("");
        return;
      }

      setLoadingNumbers(true);
      try {
        const res = await fetch(
          `/api/ai/assistants/${encodeURIComponent(assistantId)}/phone-numbers`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (res.ok && data.ok) {
          const numbers =
            channel === "phone_call"
              ? data.voice_numbers || []
              : data.messaging_numbers || [];
          setPhoneNumbers(numbers);

          // Auto-select user's voice number if it's in the list, otherwise select first
          if (numbers.length > 0) {
            const userNumber = numbers.find(
              (n) => n.phone_number === user?.voiceNumber,
            );
            setFromNumber(
              userNumber?.phone_number || numbers[0].phone_number || "",
            );
          } else {
            setFromNumber("");
          }
        } else {
          setPhoneNumbers([]);
          setFromNumber("");
        }
      } catch (err) {
        console.error("Failed to load phone numbers:", err);
        setPhoneNumbers([]);
        setFromNumber("");
      } finally {
        setLoadingNumbers(false);
      }
    }

    if (open && assistantId) {
      loadPhoneNumbers();
    }
  }, [assistantId, channel, open, user?.voiceNumber]);

  // Reset form when opening
  React.useEffect(() => {
    if (open) {
      setAssistantId(preselectedAssistantId || "");
      setChannel("phone_call");
      setFromNumber("");
      setToNumber("");
      setScheduledAt("");
      setMaxRetriesClientErrors("0");
      setRetryIntervalSecs("");
      setText("");
      setPhoneNumbers([]);
    }
  }, [open, preselectedAssistantId]);

  async function onSave() {
    if (!assistantId) {
      notify({ title: "Please select an AI assistant", variant: "error" });
      return;
    }
    if (!fromNumber) {
      notify({ title: "From number is required", variant: "error" });
      return;
    }
    if (!toNumber) {
      notify({ title: "To number is required", variant: "error" });
      return;
    }
    if (!scheduledAt) {
      notify({ title: "Scheduled date/time is required", variant: "error" });
      return;
    }
    if (channel === "sms_chat" && !text) {
      notify({ title: "Text is required for SMS events", variant: "error" });
      return;
    }

    const maxRetries = Number(maxRetriesClientErrors || 0);
    const retryInterval = retryIntervalSecs ? Number(retryIntervalSecs) : null;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      notify({ title: "Max client error retries must be between 0 and 10", variant: "error" });
      return;
    }
    if (
      retryInterval !== null &&
      (!Number.isInteger(retryInterval) ||
        retryInterval < 60 ||
        retryInterval > 86400)
    ) {
      notify({ title: "Retry interval must be between 60 and 86400 seconds", variant: "error" });
      return;
    }
    if (maxRetries > 0 && retryInterval === null) {
      notify({ title: "Retry interval is required when retries are enabled", variant: "error" });
      return;
    }

    setSaving(true);
    try {
      // Convert datetime-local to ISO 8601
      const datetime = new Date(scheduledAt).toISOString();

      const payload = {
        assistant_id: assistantId,
        telnyx_conversation_channel: channel,
        telnyx_end_user_target: toNumber,
        telnyx_agent_target: fromNumber,
        scheduled_at_fixed_datetime: datetime,
      };

      payload.max_retries_client_errors = maxRetries;
      if (retryInterval !== null) payload.retry_interval_secs = retryInterval;
      if (text) payload.text = text;

      const r = await fetch("/api/admin/scheduled-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (r.ok) {
        notify({ title: "Event scheduled successfully", variant: "success" });
        onOpenChange(false);
        onSaveComplete && onSaveComplete();
      } else {
        const d = await r.json().catch(() => ({}));
        notify({ title: "Failed to schedule event", description: d?.error || "", variant: "error" });
      }
    } catch (err) {
      notify({ title: "Failed to schedule event", description: String(err.message || err), variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconPlus className="size-5" />
            Schedule New Event
          </SheetTitle>
        </SheetHeader>

        {/* Scrollable Content Section */}
        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4">
            <CardContent className="p-6 space-y-4">
              {/* Row 1: AI Assistant, Channel */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2 min-w-0">
                  <Label className="text-sm">AI Assistant *</Label>
                  <Combobox
                    value={assistantId}
                    onChange={setAssistantId}
                    options={assistants.map((a) => ({
                      value: a.id,
                      label: a.name || a.id,
                    }))}
                    placeholder="Select an assistant"
                    searchable={true}
                    triggerClassName="w-full"
                  />
                </div>
                <div className="grid gap-2 min-w-0">
                  <Label className="text-sm">Channel *</Label>
                  <Select value={channel} onValueChange={setChannel}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select channel" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="phone_call">Call</SelectItem>
                      <SelectItem value="sms_chat">SMS</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Row 2: From Number, To Number */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2 min-w-0">
                  <Label className="text-sm">From Number *</Label>
                  <Select
                    value={fromNumber}
                    onValueChange={setFromNumber}
                    disabled={loadingNumbers || phoneNumbers.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          loadingNumbers
                            ? "Loading numbers..."
                            : phoneNumbers.length === 0
                              ? "No numbers available"
                              : "Select a number"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {phoneNumbers.map((num) => (
                        <SelectItem key={num.id} value={num.phone_number}>
                          {num.phone_number}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {phoneNumbers.length === 0 && assistantId
                      ? "No phone numbers assigned to this assistant"
                      : "Phone numbers assigned to selected assistant"}
                  </p>
                </div>
                <div className="grid gap-2 min-w-0">
                  <Label className="text-sm">To Number *</Label>
                  <Input
                    value={toNumber}
                    onChange={(e) => setToNumber(e.target.value)}
                    placeholder="+15559876543"
                  />
                  <p className="text-xs text-muted-foreground">
                    Phone number in E.164 format
                  </p>
                </div>
              </div>

              {/* Row 3: Scheduled Date/Time */}
              <div className="grid gap-2">
                <Label className="text-sm">Scheduled Date & Time *</Label>
                <Input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Select the date and time when the event should be triggered
                </p>
              </div>

              {/* Row 4: Retry Settings */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2 min-w-0">
                  <Label className="text-sm">Max Client Error Retries</Label>
                  <Input
                    type="number"
                    min="0"
                    max="10"
                    step="1"
                    value={maxRetriesClientErrors}
                    onChange={(e) => setMaxRetriesClientErrors(e.target.value)}
                    placeholder="0"
                  />
                  <p className="text-xs text-muted-foreground">
                    Retries on busy, no-answer, failed, or canceled calls (0-10)
                  </p>
                </div>
                <div className="grid gap-2 min-w-0">
                  <Label className="text-sm">Retry Interval (seconds)</Label>
                  <Input
                    type="number"
                    min="60"
                    max="86400"
                    step="1"
                    value={retryIntervalSecs}
                    onChange={(e) => setRetryIntervalSecs(e.target.value)}
                    placeholder="300"
                    disabled={Number(maxRetriesClientErrors || 0) === 0}
                  />
                  <p className="text-xs text-muted-foreground">
                    Delay between retry attempts, from 60 seconds to 24 hours
                  </p>
                </div>
              </div>

              {/* Row 5: Text (for SMS) */}
              {channel === "sms_chat" && (
                <div className="grid gap-2">
                  <Label className="text-sm">Message Text *</Label>
                  <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Enter the SMS text message..."
                    rows={4}
                  />
                  <p className="text-xs text-muted-foreground">
                    The text message to send to the recipient (required for SMS)
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Fixed Footer */}
        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? "Scheduling..." : "Schedule Event"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
