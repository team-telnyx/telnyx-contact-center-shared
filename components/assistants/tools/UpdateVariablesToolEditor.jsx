"use client";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IconPlus, IconTrash } from "@tabler/icons-react";

export default function UpdateVariablesToolEditor({ value, onChange }) {
  const t = useUiText();
  const config = value?.update_dynamic_variables || {};
  const variables = config.updatable_variables || [];
  const update = patch => onChange({ ...value, update_dynamic_variables: { ...config, ...patch } });
  const updateVariable = (index, patch) => update({ updatable_variables: variables.map((item, i) => i === index ? { ...item, ...patch } : item) });
  return <div className="space-y-6">
    <div className="space-y-2"><Label htmlFor="update-tool-name">{t("Name")}</Label><Input id="update-tool-name" value={config.name || ""} placeholder="collect_details" onChange={e => update({ name: e.target.value })} /></div>
    <div className="space-y-2"><Label htmlFor="update-tool-description">{t("Description")}</Label><Textarea id="update-tool-description" rows={3} value={config.description || ""} placeholder={t("Tell the assistant when to capture or update these details.")} onChange={e => update({ description: e.target.value })} /></div>
    <section className="space-y-4 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">{t("Variables to update")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("The assistant can change only the variables listed here.")}</p></div><Button variant="outline" size="sm" type="button" onClick={() => update({ updatable_variables: [...variables, { name: "", type: "string", description: "" }] })}><IconPlus className="size-4" />{t("Add variable")}</Button></div>
      {!variables.length && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t("Add a variable to capture details from the conversation.")}</p>}
      {variables.map((item, index) => <div key={index} className="space-y-3 border-b pb-4 last:border-0 last:pb-0">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3">
          <div className="space-y-2"><Label htmlFor={`variable-name-${index}`}>{t("Variable name")}</Label><Input id={`variable-name-${index}`} value={item.name || ""} placeholder="customer_name" onChange={e => updateVariable(index, { name: e.target.value })} /></div>
          <div className="space-y-2"><Label htmlFor={`variable-type-${index}`}>{t("Value format")}</Label><Select value={item.type || "auto"} onValueChange={type => updateVariable(index, { type: type === "auto" ? undefined : type })}><SelectTrigger id={`variable-type-${index}`} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{[["auto", "Automatic"], ["string", "Text"], ["number", "Number"], ["boolean", "Yes / No"], ["object", "Structured details"], ["array", "List"], ...(![undefined, "", "string", "number", "boolean", "object", "array"].includes(item.type) ? [[item.type, item.type]] : [])].map(([v, label]) => <SelectItem key={v} value={v}>{t(label)}</SelectItem>)}</SelectContent></Select></div>
          <Button type="button" variant="ghost" size="icon" aria-label={t("Remove variable {value0}", { value0: index + 1 })} onClick={() => update({ updatable_variables: variables.filter((_, i) => i !== index) })}><IconTrash className="size-4 text-destructive" /></Button>
        </div>
        <div className="space-y-2"><Label htmlFor={`variable-description-${index}`}>{t("What should the assistant capture?")}</Label><Input id={`variable-description-${index}`} value={item.description || ""} placeholder={t("For example, the caller's full name")} onChange={e => updateVariable(index, { description: e.target.value })} /></div>
      </div>)}
    </section>
  </div>;
}
