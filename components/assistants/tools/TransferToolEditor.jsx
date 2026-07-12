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
import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";

export default function TransferToolEditor({
  value,
  onChange,
  availableVariables = [],
}) {
  const tr = value?.transfer || {};
  const targets = Array.isArray(tr.targets) ? tr.targets : [];
  const sipHeaders = Array.isArray(tr.sip_headers) ? tr.sip_headers : [];
  const customHeaders = Array.isArray(tr.custom_headers)
    ? tr.custom_headers
    : [];
  function update(partial) {
    onChange?.({
      ...(value || { type: "transfer" }),
      transfer: { ...(value?.transfer || {}), ...partial },
    });
  }
  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs">From</label>
        <VariableInput
          value={tr.from || ""}
          availableVariables={availableVariables}
          secrets={[]}
          onChange={(next) => update({ from: next })}
          placeholder="+13125551234 or {{telnyx_agent_target}}"
        />
      </div>
      <div>
        <label className="text-xs">Warm Transfer Instructions</label>
        <VariableTextarea
          rows={3}
          value={value?.warm_transfer_instructions || ""}
          availableVariables={availableVariables}
          secrets={[]}
          onChange={(next) =>
            onChange?.({
              ...(value || { type: "transfer" }),
              warm_transfer_instructions: next,
            })
          }
          placeholder="Instructions given to the agent during a warm transfer handoff"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Instructions given to the agent during a warm transfer handoff.
        </p>
      </div>
      <div className="space-y-2">
        <div className="text-xs">Targets</div>
        {targets.map((t, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Input
              className="md:col-span-6"
              placeholder="Name"
              value={t?.name || ""}
              onChange={(e) => {
                const next = targets.map((x, idx) =>
                  idx === i ? { ...x, name: e.target.value } : x
                );
                update({ targets: next });
              }}
            />
            <div className="md:col-span-4">
              <VariableInput
                placeholder="To (E.164 or SIP URI)"
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
            <div className="md:col-span-2 flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() =>
                  update({ targets: targets.filter((_, idx) => idx !== i) })
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
            update({ targets: [...targets, { name: "", to: "" }] })
          }
        >
          Add Target
        </Button>
      </div>

      <div className="space-y-2">
        <div className="text-xs">SIP Headers (User-to-User or Diversion)</div>
        {sipHeaders.map((h, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Select
              value={h?.name || "User-to-User"}
              onValueChange={(val) => {
                const next = sipHeaders.map((x, idx) =>
                  idx === i ? { ...x, name: val } : x
                );
                update({ sip_headers: next });
              }}
            >
              <SelectTrigger className="md:col-span-4">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="User-to-User">User-to-User</SelectItem>
                <SelectItem value="Diversion">Diversion</SelectItem>
              </SelectContent>
            </Select>
            <div className="md:col-span-6">
              <VariableInput
                placeholder="Header value"
                value={h?.value || ""}
                availableVariables={availableVariables}
                secrets={[]}
                onChange={(nextValue) => {
                  const next = sipHeaders.map((x, idx) =>
                    idx === i ? { ...x, value: nextValue } : x
                  );
                  update({ sip_headers: next });
                }}
              />
            </div>
            <div className="md:col-span-1 flex justify-center">
              <SecretSelector
                onSelect={(template) => {
                  const next = sipHeaders.map((x, idx) =>
                    idx === i ? { ...x, value: template } : x
                  );
                  update({ sip_headers: next });
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
                    sip_headers: sipHeaders.filter((_, idx) => idx !== i),
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
              sip_headers: [...sipHeaders, { name: "User-to-User", value: "" }],
            })
          }
        >
          Add SIP Header
        </Button>
      </div>

      <div className="space-y-2">
        <div className="text-xs">Custom Headers</div>
        {customHeaders.map((h, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Input
              className="md:col-span-4"
              placeholder="Header name"
              value={h?.name || ""}
              onChange={(e) => {
                const next = customHeaders.map((x, idx) =>
                  idx === i ? { ...x, name: e.target.value } : x
                );
                update({ custom_headers: next });
              }}
            />
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
      </div>
    </div>
  );
}
