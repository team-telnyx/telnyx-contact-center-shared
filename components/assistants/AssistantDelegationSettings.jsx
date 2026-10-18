"use client";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import AssistantModelConfiguration from "./AssistantModelConfiguration";
export default function AssistantDelegationSettings({ values, setValues }) {
  const tUi = useUiText();
  const value = values.delegation_settings;
  const update = (patch) =>
    setValues((v) => ({
      ...v,
      delegation_settings: { ...v.delegation_settings, ...patch },
    }));
  if (!value)
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border p-4">
        <div>
          <h3 className="text-sm font-semibold">{tUi("Delegation")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {tUi(
              "Let a separate model or your server handle work during the conversation.",
            )}
          </p>
        </div>
        <Switch aria-label={tUi("Enable delegation")} checked={false} onCheckedChange={enabled=>update({enabled,mode:"telnyx"})}/>
      </div>
    );
  return (
    <div className="space-y-5 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <label htmlFor="delegation-enabled" className="text-sm font-medium">
          {tUi("Enable delegation")}
        </label>
        <Switch
          id="delegation-enabled"
          checked={value.enabled !== false}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </div>
      {value.enabled !== false ? <>
      <div className="space-y-2">
        <label htmlFor="delegation-mode" className="text-sm font-medium">
          {tUi("Delegation mode")}
        </label>
        <Select value={value.mode || "telnyx"} onValueChange={mode=>update({mode})}><SelectTrigger id="delegation-mode"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="telnyx">{tUi("Telnyx backend model")}</SelectItem><SelectItem value="client">{tUi("Your server over WebSocket")}</SelectItem></SelectContent></Select>
      </div>
      {value.mode !== "client" ? (
        <AssistantModelConfiguration
          label="Delegation model"
          value={value}
          onChange={(cfg) =>
            update({
              model: cfg.external_llm ? undefined : cfg.model,
              llm_api_key_ref: cfg.llm_api_key_ref,
              external_llm: cfg.external_llm || undefined,
            })
          }
          ui={values._modelUi?.delegation}
          onUiChange={(next) =>
            setValues((v) => ({
              ...v,
              _modelUi: { ...v._modelUi, delegation: next },
            }))
          }
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {tUi(
            "Configure the WebSocket connection under Integrations → Observability. The server must handle delegation requests and return results.",
          )}
        </p>
      )}
      <div className="space-y-2">
        <label
          htmlFor="delegation-instructions"
          className="text-sm font-medium"
        >
          {tUi("Backend instructions")}
        </label>
        <Textarea
          id="delegation-instructions"
          value={value.instructions || ""}
          onChange={(e) => update({ instructions: e.target.value })}
        />
      </div>
      <div className="flex items-center justify-between">
        <label htmlFor="delegation-speak" className="text-sm font-medium">
          {tUi("Speak delegation results")}
        </label>
        <Switch
          id="delegation-speak"
          checked={value.speak_results !== false}
          onCheckedChange={(speak_results) => update({ speak_results })}
        />
      </div>
      </> : null}
    </div>
  );
}
