"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { IconTrash } from "@tabler/icons-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import SecretSelector from "@/components/assistants/SecretSelector";
import { VariableInput } from "@/components/voice-flow/VariableInput";

export default function InviteToolEditor({
  value,
  onChange,
  availableVariables = [],
}) {
  const inv = value?.invite || {};
  const targets = Array.isArray(inv.targets) ? inv.targets : [];
  const customHeaders = Array.isArray(inv.custom_headers)
    ? inv.custom_headers
    : [];
  const voicemailDetection = inv.voicemail_detection || {};

  function update(partial) {
    onChange?.({
      ...(value || { type: "invite" }),
      invite: { ...(value?.invite || {}), ...partial },
    });
  }

  function updateVoicemailDetection(partial) {
    update({
      voicemail_detection: {
        ...voicemailDetection,
        ...partial,
      },
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs">From Number/SIP URI</label>
        <VariableInput
          value={inv.from || ""}
          onChange={(next) => update({ from: next })}
          availableVariables={availableVariables}
          secrets={[]}
          placeholder="+13125551234, sip:user@domain.com, or {{telnyx_agent_target}}"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Required. Number or SIP URI placing the invite call. Type {"{{"} to insert a system or custom dynamic variable.
        </p>
      </div>

      <div className="space-y-3 border rounded-md p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium">Targets</div>
            <p className="text-xs text-muted-foreground mt-1">
              Define the participants the assistant can invite. Each target has a name and a destination number/SIP URI, same shape as Transfer targets.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              update({ targets: [...targets, { name: "", to: "" }] })
            }
          >
            Add Target
          </Button>
        </div>

        <div className="space-y-2">
          {targets.map((t, i) => (
            <div key={i} className="space-y-1 rounded-md border p-3">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
                <div className="md:col-span-5">
                  <label className="text-xs">Name</label>
                  <Input
                    placeholder="Support, Sales"
                    value={t?.name || ""}
                    onChange={(e) => {
                      const next = targets.map((x, idx) =>
                        idx === i ? { ...x, name: e.target.value } : x
                      );
                      update({ targets: next });
                    }}
                  />
                </div>
                <div className="md:col-span-6">
                  <label className="text-xs">To Number/SIP URI</label>
                  <VariableInput
                    placeholder="+13129457420, sip:user@example.com, or {{participant_target}}"
                    value={t?.to || ""}
                    availableVariables={availableVariables}
                    secrets={[]}
                    onChange={(nextValue) => {
                      const next = targets.map((x, idx) =>
                        idx === i ? { ...x, to: nextValue } : x
                      );
                      update({ targets: next });
                    }}
                  />
                </div>
                <div className="md:col-span-1 flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      update({
                        targets: targets.filter((_, idx) => idx !== i),
                      })
                    }
                    aria-label="Remove target"
                  >
                    <IconTrash />
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {targets.length === 0 && (
            <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              No invite targets yet. Add a target, or leave empty if targets are supplied dynamically at runtime by Telnyx/tool context.
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs">Custom Headers</div>
        {customHeaders.map((h, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <div className="md:col-span-4">
              <Input
                placeholder="Header name"
                value={h?.name || ""}
                onChange={(e) => {
                  const next = customHeaders.map((x, idx) =>
                    idx === i ? { ...x, name: e.target.value } : x
                  );
                  update({ custom_headers: next });
                }}
              />
            </div>
            <div className="md:col-span-6">
              <VariableInput
                placeholder="Header value"
                value={h?.value || ""}
                availableVariables={availableVariables}
                secrets={[]}
                onChange={(nextValue) => {
                  const next = customHeaders.map((x, idx) =>
                    idx === i ? { ...x, value: nextValue } : x
                  );
                  update({ custom_headers: next });
                }}
              />
            </div>
            <div className="md:col-span-1 flex justify-center">
              <SecretSelector
                onSelect={(template) => {
                  const next = customHeaders.map((x, idx) =>
                    idx === i ? { ...x, value: template } : x
                  );
                  update({ custom_headers: next });
                }}
              />
            </div>
            <div className="md:col-span-1 flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() =>
                  update({
                    custom_headers: customHeaders.filter((_, idx) => idx !== i),
                  })
                }
                aria-label="Remove"
              >
                <IconTrash />
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          onClick={() =>
            update({
              custom_headers: [...customHeaders, { name: "", value: "" }],
            })
          }
        >
          Add Custom Header
        </Button>
        <p className="text-xs text-muted-foreground">
          Custom headers added to the SIP INVITE. Header values support {"{{"} dynamic variables and integration secrets.
        </p>
      </div>

      <div className="space-y-3 border rounded-md p-3">
        <div className="text-xs font-medium">Voicemail Detection (AMD)</div>
        <div>
          <label className="text-xs">Detection Mode</label>
          <Select
            value={voicemailDetection.detection_mode || "disabled"}
            onValueChange={(val) =>
              updateVoicemailDetection({ detection_mode: val })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">Disabled</SelectItem>
              <SelectItem value="premium">Premium</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            &ldquo;premium&rdquo; enables answering machine detection on the invited call.
          </p>
        </div>
        {voicemailDetection.detection_mode === "premium" && (
          <div>
            <label className="text-xs">On Voicemail Detected — Action</label>
            <Select
              value={
                voicemailDetection.on_voicemail_detected?.action ||
                "stop_invite"
              }
              onValueChange={(val) =>
                updateVoicemailDetection({
                  on_voicemail_detected: { action: val },
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stop_invite">Stop Invite</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Action to take when voicemail is detected on the invited call.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
