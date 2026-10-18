"use client";
import { useId, useRef } from "react";
import { Switch } from "@/components/ui/switch";
import { useUiText } from "@/components/i18n/use-ui-text";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { IconTrash } from "@tabler/icons-react";
import SecretSelector from "@/components/assistants/SecretSelector";
import { VariableInput } from "@/components/voice-flow/VariableInput";
import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";

export default function TransferToolEditor({
  value,
  onChange,
  availableVariables = [],
}) {
  const tUi = useUiText();
  const headerNamesId = useId();
  const tr = value?.transfer || {};
  const targets = Array.isArray(tr.targets) ? tr.targets : [];
  const dynamicTargets = typeof tr.targets === "string";
  const targetDrafts = useRef({
    list: targets,
    dynamic: dynamicTargets ? tr.targets : "{{targets}}",
  });
  function updateTarget(index, key, nextValue) {
    update({
      targets: targets.map((target, i) =>
        i === index ? { ...target, [key]: nextValue || undefined } : target,
      ),
    });
  }
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
        <label className="text-xs">{tUi("From")}</label>
        <VariableInput
          value={tr.from || ""}
          availableVariables={availableVariables}
          secrets={[]}
          onChange={(next) => update({ from: next })}
          placeholder={tUi("+13125551234 or {{telnyx_agent_target}}")}
        />
      </div>
      <div>
        <label className="text-xs">{tUi("Warm Transfer Instructions")}</label>
        <VariableTextarea
          rows={3}
          value={tr.warm_transfer_instructions || ""}
          availableVariables={availableVariables}
          secrets={[]}
          onChange={(next) => update({ warm_transfer_instructions: next })}
          placeholder={tUi(
            "Instructions given to the agent during a warm transfer handoff",
          )}
        />
        <p className="text-xs text-muted-foreground mt-1">
          {tUi(
            "Instructions given to the agent during a warm transfer handoff.",
          )}
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs">{tUi("Targets")}</span>
          <label
            className="flex items-center gap-2 text-xs"
            htmlFor={`${headerNamesId}-dynamic`}
          >
            <Switch
              id={`${headerNamesId}-dynamic`}
              checked={dynamicTargets}
              onCheckedChange={(enabled) => {
                targetDrafts.current[dynamicTargets ? "dynamic" : "list"] =
                  tr.targets;
                update({
                  targets:
                    targetDrafts.current[enabled ? "dynamic" : "list"] ||
                    (enabled ? "{{targets}}" : []),
                });
              }}
            />
            {tUi("Dynamic targets")}
          </label>
        </div>
        {dynamicTargets ? (
          <VariableInput
            value={tr.targets}
            onChange={(targets) => update({ targets })}
            availableVariables={availableVariables}
            secrets={[]}
            placeholder="{{targets}}"
          />
        ) : null}
        {targets.map((t, i) => (
          <div
            key={i}
            data-transfer-target={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Input
              className="md:col-span-6"
              placeholder={tUi("Name")}
              value={t?.name || ""}
              onChange={(e) => {
                const next = targets.map((x, idx) =>
                  idx === i ? { ...x, name: e.target.value } : x,
                );
                update({ targets: next });
              }}
            />
            <div className="md:col-span-4">
              <VariableInput
                placeholder={tUi("To (E.164 or SIP URI)")}
                value={t?.to || ""}
                availableVariables={availableVariables}
                secrets={[]}
                onChange={(nextValue) => {
                  const next = targets.map((x, idx) =>
                    idx === i ? { ...x, to: nextValue } : x,
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
                aria-label={tUi("Remove")}
              >
                <IconTrash />
              </Button>
            </div>
            <details className="md:col-span-12 rounded-md border p-3">
              <summary className="cursor-pointer text-xs font-medium">
                {tUi("Advanced")}
              </summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="space-y-1 md:col-span-2">
                  <label className="text-xs">{tUi("Message")}</label>
                  <VariableTextarea
                    value={t.message || ""}
                    onChange={(text) => updateTarget(i, "message", text)}
                    availableVariables={availableVariables}
                    secrets={[]}
                  />
                </div>
                {[
                  ["extension", "Extension"],
                  ["sip_auth_username", "SIP Auth Username"],
                  ["sip_auth_password", "SIP Auth Password"],
                ].map(([key, label]) => (
                  <div key={key} className="space-y-1">
                    <label
                      className="text-xs"
                      htmlFor={`${headerNamesId}-${i}-${key}`}
                    >
                      {tUi(label)}
                    </label>
                    <Input
                      id={`${headerNamesId}-${i}-${key}`}
                      data-transfer-field={key}
                      type={key === "sip_auth_password" ? "password" : "text"}
                      autoComplete={
                        key === "sip_auth_password" ? "new-password" : "off"
                      }
                      maxLength={key === "extension" ? 64 : undefined}
                      value={t[key] || ""}
                      onChange={(event) =>
                        updateTarget(i, key, event.target.value)
                      }
                    />
                  </div>
                ))}
              </div>
            </details>
          </div>
        ))}
        {!dynamicTargets ? (
          <Button
            type="button"
            onClick={() =>
              update({ targets: [...targets, { name: "", to: "" }] })
            }
          >
            {tUi("Add Target")}
          </Button>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="text-xs">{tUi("Custom Headers")}</div>
        <datalist id={headerNamesId}>
          <option value="User-to-User" />
          <option value="Diversion" />
        </datalist>
        {customHeaders.map((h, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Input
              className="md:col-span-4"
              placeholder={tUi("Header name")}
              list={headerNamesId}
              value={h?.name || ""}
              onChange={(e) => {
                const next = customHeaders.map((x, idx) =>
                  idx === i ? { ...x, name: e.target.value } : x,
                );
                update({ custom_headers: next });
              }}
            />
            <div className="md:col-span-6">
              <VariableInput
                placeholder={tUi("Header value")}
                value={h?.value || ""}
                availableVariables={availableVariables}
                secrets={[]}
                onChange={(nextValue) => {
                  const next = customHeaders.map((x, idx) =>
                    idx === i ? { ...x, value: nextValue } : x,
                  );
                  update({ custom_headers: next });
                }}
              />
            </div>
            <div className="md:col-span-1 flex justify-center">
              <SecretSelector
                onSelect={(template) => {
                  const next = customHeaders.map((x, idx) =>
                    idx === i ? { ...x, value: template } : x,
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
                aria-label={tUi("Remove")}
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
          {tUi("Add Custom Header")}
        </Button>
      </div>
    </div>
  );
}
