"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { Input } from "@/components/ui/input";
import { VariableInput } from "@/components/voice-flow/VariableInput";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { IconTrash } from "@tabler/icons-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import SecretSelector from "@/components/assistants/SecretSelector";

export default function ReferToolEditor({
  value,
  onChange,
  availableVariables = [],
}) {
  const tUi = useUiText();
  const rf = value?.refer || {};
  const targets = Array.isArray(rf.targets) ? rf.targets : [];
  const sipHeaders = Array.isArray(rf.sip_headers) ? rf.sip_headers : [];
  const customHeaders = Array.isArray(rf.custom_headers)
    ? rf.custom_headers
    : [];
  function update(partial) {
    onChange?.({
      ...(value || { type: "refer" }),
      refer: { ...(value?.refer || {}), ...partial },
    });
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-xs">{tUi("Targets")}</div>
        {targets.map((t, i) => (
          <div key={i} className="border rounded p-2 space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
              <Input
                className="md:col-span-4"
                placeholder={tUi("Name")}
                value={t?.name || ""}
                onChange={(e) => {
                  const next = targets.map((x, idx) =>
                    idx === i ? { ...x, name: e.target.value } : x
                  );
                  update({ targets: next });
                }}
              />
              <div className="md:col-span-7">
                <VariableInput
                  placeholder={tUi("SIP Address (sip:user@domain)")}
                  value={t?.sip_address || ""}
                  availableVariables={availableVariables}
                  secrets={[]}
                  onChange={(nextValue) => {
                    const next = targets.map((x, idx) =>
                      idx === i ? { ...x, sip_address: nextValue } : x
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
                    update({ targets: targets.filter((_, idx) => idx !== i) })
                  }
                  aria-label={tUi("Remove")}
                >
                  <IconTrash />
                </Button>
              </div>
            </div>
            {t?.__showAdvanced ? (
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                <div className="md:col-span-6">
                  <VariableInput
                    placeholder={tUi("SIP Auth Username")}
                    value={t?.sip_auth_username || ""}
                    availableVariables={availableVariables}
                    secrets={[]}
                    onChange={(nextValue) => {
                      const next = targets.map((x, idx) =>
                        idx === i
                          ? { ...x, sip_auth_username: nextValue }
                          : x
                      );
                      update({ targets: next });
                    }}
                  />
                </div>
                <div className="md:col-span-5">
                  <VariableInput
                    className="w-full"
                    placeholder={tUi("SIP Auth Password")}
                    value={t?.sip_auth_password || ""}
                    availableVariables={availableVariables}
                    secrets={[]}
                    onChange={(nextValue) => {
                      const next = targets.map((x, idx) =>
                        idx === i
                          ? { ...x, sip_auth_password: nextValue }
                          : x
                      );
                      update({ targets: next });
                    }}
                    type={t?.sip_auth_password?.includes("{{#integration_secret}}") ? "text" : "password"}
                  />
                </div>
                <div className="md:col-span-1 flex justify-center">
                  <SecretSelector
                    onSelect={(template) => {
                      const next = targets.map((x, idx) =>
                        idx === i ? { ...x, sip_auth_password: template } : x
                      );
                      update({ targets: next });
                    }}
                  />
                </div>
              </div>
            ) : null}
            <div className="flex justify-between items-center">
              <div />
              <label className="inline-flex items-center gap-2 text-xs">
                <span>{tUi("Advanced options")}</span>
                <Switch
                  checked={Boolean(t?.__showAdvanced)}
                  onCheckedChange={(v) => {
                    const next = targets.map((x, idx) =>
                      idx === i ? { ...x, __showAdvanced: Boolean(v) } : x
                    );
                    update({ targets: next });
                  }}
                />
              </label>
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <Button
            type="button"
            onClick={() =>
              update({ targets: [...targets, { name: "", sip_address: "" }] })
            }
          >{tUi("Add Target")}</Button>
          {/* Advanced options switch moved into each card */}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs">{tUi("SIP Headers (User-to-User or Diversion)")}</div>
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
                <SelectItem value="User-to-User">{tUi("User-to-User")}</SelectItem>
                <SelectItem value="Diversion">{tUi("Diversion")}</SelectItem>
              </SelectContent>
            </Select>
            <div className="md:col-span-6">
              <VariableInput
                placeholder={tUi("Header value")}
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
              sip_headers: [...sipHeaders, { name: "User-to-User", value: "" }],
            })
          }
        >{tUi("Add SIP Header")}</Button>
      </div>

      <div className="space-y-2">
        <div className="text-xs">{tUi("Custom Headers")}</div>
        {customHeaders.map((h, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Input
              className="md:col-span-4"
              placeholder={tUi("Header name")}
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
                placeholder={tUi("Header value")}
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
        >{tUi("Add Custom Header")}</Button>
      </div>
    </div>
  );
}
