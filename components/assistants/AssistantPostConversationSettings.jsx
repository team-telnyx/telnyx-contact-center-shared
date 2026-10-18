"use client";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import AssistantConfigurationCard from "./AssistantConfigurationCard";
import { getAssistantToolDisplay, renderAssistantToolIcon } from "./AssistantToolEditSheet";
export default function AssistantPostConversationSettings({ values, setValues }) {
  const t = useUiText();
  const enabled = values.post_conversation_settings?.enabled === true;
  const tools = (values.tools || []).filter(tool => ["webhook", "function", "retrieval"].includes(tool.type));
  return <div className="space-y-4" data-setting-path="post_conversation_settings">
    <AssistantConfigurationCard title="Post-conversation processing" description="Give the assistant a final turn to complete follow-up tasks after a phone call ends.">
      <div className="flex items-center justify-between gap-4"><Label htmlFor="after-call-processing">{t("After-call processing")}</Label><Switch id="after-call-processing" checked={enabled} onCheckedChange={checked => setValues(v => ({ ...v, post_conversation_settings: { ...v.post_conversation_settings, enabled: checked } }))} /></div>
    </AssistantConfigurationCard>
    {enabled && <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <AssistantConfigurationCard title="Instructions for follow-up work" description="Telnyx uses the same assistant instructions during and after a call. Describe after-call tasks explicitly here; edits also appear in Agent → Instructions.">
        <Label htmlFor="after-call-instructions">{t("Assistant instructions")}</Label><Textarea id="after-call-instructions" className="min-h-80 resize-y" value={values.instructions || ""} onChange={e => setValues(v => ({ ...v, instructions: e.target.value }))} placeholder={t("After the call ends, use the summary webhook to save a concise summary and the agreed next steps.")} />
      </AssistantConfigurationCard>
      <AssistantConfigurationCard title="Available after the call" description="Webhooks, functions and knowledge retrieval can support follow-up tasks.">
        {tools.length ? <ul className="divide-y">{tools.map((tool, i) => { const display = getAssistantToolDisplay(tool); return <li key={tool.tool_id || i} className="flex items-start gap-3 py-3 first:pt-0"><span className="mt-0.5">{renderAssistantToolIcon(tool.type)}</span><div className="min-w-0"><p className="break-words text-sm font-medium">{display.name}</p><p className="mt-1 text-xs text-muted-foreground">{display.description}</p></div></li>; })}</ul> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t("Add a webhook or function in Integrations → Tools to perform follow-up actions.")}</p>}
        <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">{t("MCP integrations, call controls, client-side tools and variable updates are unavailable after the call. Use a webhook to reach your application. Results are recorded in conversation history when data retention is enabled.")}</p>
      </AssistantConfigurationCard>
    </div>}
  </div>;
}
