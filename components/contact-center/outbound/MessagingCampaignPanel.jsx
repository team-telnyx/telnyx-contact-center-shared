"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronLeft, IconChevronRight, IconListCheck, IconMessage, IconSend, IconSparkles, IconTemplate, IconUsers, IconWand } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/components/ToastNotify";
import DraftTextInput from "./DraftTextInput";
import SettingsFieldInfo from "./SettingsFieldInfo";
import { describeSmsSegments } from "@/lib/sms/segments.mjs";
import { MESSAGING_REQUIREMENT_LABELS, SMS_SENDER_STRATEGIES, messagingCampaignConfig, messagingDestinationOptions } from "@/lib/outbound-dialer/messaging/campaign-config.mjs";
import { MISSING_VARIABLE_POLICIES, SYSTEM_VARIABLES, VARIABLE_SOURCES, autoMapVariables, mergeVariableMapping, messagingTemplateVariableKeys } from "@/lib/outbound-dialer/messaging/variables.mjs";
import { effectiveMessagingPacing } from "@/lib/outbound-dialer/messaging/campaign-config.mjs";

const title = (value) => String(value || "").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
const SOURCE_LABELS = { contact_field: "Contact field", contact_method: "Contact method", static: "Static text", system: "System value" };
const POLICY_LABELS = { skip: "Skip the contact", fallback: "Use fallback values only", send_blank: "Send with blank placeholders" };
const STRATEGY_LABELS = { round_robin: "Round robin across numbers", sticky_hash: "Same number for the same customer", rotate_on_retry: "Rotate on retry" };
const TEMPLATE_SOURCE = { sms: "Create templates under Admin → SMS → Templates", whatsapp: "No approved WhatsApp templates. Create and submit one under Admin → WhatsApp → Templates.", email: "Create templates under Admin → Email → Templates" };
const MEDIA_HEADER_FORMATS = ["IMAGE", "VIDEO", "DOCUMENT"];
// The panel is a narrow drawer: a trigger must shrink with its column and
// ellipsise, and the popup must never grow past the trigger it belongs to.
const SELECT_TRIGGER = "h-9 w-full min-w-0 overflow-hidden [&>span]:truncate";
const SELECT_CONTENT = "w-[--radix-select-trigger-width] max-w-[--radix-select-trigger-width]";
const SENDER_SUBTITLE = {
  sms: "Numbers this campaign sends from. Replies reach the queue mapped to the number.",
  whatsapp: "The WhatsApp number this campaign sends from. Replies reach the queue mapped to the number.",
  email: "The mailbox this campaign sends from. Replies reach the queue mapped to the mailbox.",
};

function PanelCard({ icon: Icon, title: cardTitle, subtitle, children, testId }) {
  return <div className="rounded-2xl border bg-background/85 p-4 shadow-sm" data-testid={testId}><div className="mb-4 flex items-start gap-3"><span className="rounded-xl bg-gradient-to-br from-sky-500/15 to-violet-500/15 p-2 text-sky-600"><Icon className="h-4 w-4" /></span><div><h3 className="text-sm font-semibold">{cardTitle}</h3><p className="text-xs text-muted-foreground">{subtitle}</p></div></div>{children}</div>;
}
// One-line label plus an info icon so inputs in a row keep the same baseline.
function FieldLabel({ children, required, hint }) {
  const text = typeof children === "string" ? children : "";
  return <div className="flex h-5 min-w-0 items-center gap-1"><Label className="min-w-0 truncate text-sm" title={text || undefined}>{children}{required ? <span aria-hidden="true" className="ml-1 text-red-500">*</span> : null}</Label><SettingsFieldInfo hint={hint} label={text} /></div>;
}
// Four columns only fit a wide container; in the configuration drawer each
// mapping row stacks and every control keeps a label of its own.
const MAPPING_HEADER_CLASS = "hidden gap-2 bg-muted/60 px-3 py-2 text-xs font-semibold text-muted-foreground @[720px]:grid @[720px]:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)]";
const MAPPING_ROW_CLASS = "grid gap-2 border-t px-3 py-3 @[720px]:items-center @[720px]:py-2 @[720px]:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)]";
function MappingField({ label, children }) {
  return <div className="min-w-0 space-y-1"><span className="block text-[11px] font-medium text-muted-foreground @[720px]:hidden">{label}</span>{children}</div>;
}
function NumberField({ label, value, onChange, min, max, hint }) {
  return <div className="min-w-0 space-y-2"><FieldLabel hint={hint}>{label}</FieldLabel><Input type="number" min={min} max={max} value={value ?? ""} placeholder="inherit" onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} /></div>;
}

function contactListFields(list) {
  const importSettings = list?.metadata?.csv_import_settings || list?.metadata?.csvImportSettings || {};
  const names = [...(list?.custom_field_schema || []).map((f) => f?.name), ...(importSettings.field_schema || []).map((f) => f?.name), ...(importSettings.selected_columns || []), ...(list?.row_data_columns || [])];
  return [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))];
}
function contactMethodSlots(list) {
  const mappings = list?.metadata?.csv_import_settings?.column_mappings || {};
  return [...new Set(Object.values(mappings).flat().filter((value) => typeof value === "string" && value.includes(":")))];
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

// Channel-specific cards for a messaging (broadcast) campaign: sender, template
// and variable mapping with a live preview, audience validation, test sends
// and the pacing limits the campaign may tighten.
export default function MessagingCampaignPanel({ draft, update, updateMetadata, contactLists = [], outboundSettings = {}, senders = {}, templates = {}, saving = false, requirements = null, unsaved = false }) {
  const channel = String(draft?.channel || "sms").toLowerCase();
  const config = useMemo(() => messagingCampaignConfig(draft), [draft]);
  const list = contactLists.find((item) => item.id === draft?.contact_list_id) || null;
  const channelTemplates = templates?.[channel] || [];
  const channelSenders = senders?.[channel] || [];
  const template = channelTemplates.find((item) => item.id === config.template[channel]?.template_id) || null;
  // The template's variables plus the ones an e-mail subject override adds:
  // the server requires a mapping for both, so the editor shows a row for both.
  const templateVariables = useMemo(() => messagingTemplateVariableKeys(template, config), [template, config]);
  const fields = useMemo(() => contactListFields(list), [list]);
  const slots = useMemo(() => contactMethodSlots(list), [list]);
  const destinationOptions = useMemo(() => messagingDestinationOptions(list, channel), [list, channel]);
  const pacing = useMemo(() => effectiveMessagingPacing(draft, outboundSettings), [draft, outboundSettings]);
  const globalMessaging = outboundSettings?.messaging || {};
  const setConfig = useCallback((patch) => updateMetadata({ messaging: { ...config, ...patch } }), [config, updateMetadata]);
  const setSender = (patch) => setConfig({ sender: { ...config.sender, [channel]: { ...config.sender[channel], ...patch } } });
  const setTemplate = (patch) => setConfig({ template: { ...config.template, [channel]: { ...config.template[channel], ...patch } } });
  const mapping = useMemo(() => mergeVariableMapping(config.variable_mapping, templateVariables), [config.variable_mapping, templateVariables]);
  const updateRow = (key, patch) => setConfig({ variable_mapping: mapping.map((row) => (row.key === key ? { ...row, ...patch } : row)) });

  const [sampleIndex, setSampleIndex] = useState(0);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState("");
  const [validation, setValidation] = useState(draft?.metadata?.messaging_runtime?.last_validation || null);
  const [validating, setValidating] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const previewRevision = useRef(0);
  const previewKey = JSON.stringify({ channel, list: draft?.contact_list_id, config, sampleIndex, name: draft?.name });
  useEffect(() => {
    if (!draft?.contact_list_id || !config.template[channel]?.template_id) { setPreview(null); return undefined; }
    const revision = ++previewRevision.current;
    const timer = setTimeout(async () => {
      try {
        const result = await postJson("/api/contact-center/outbound-dialer/messaging/preview", { campaign: { ...draft, channel, metadata: { ...(draft.metadata || {}), messaging: config } }, sample_index: sampleIndex });
        if (revision !== previewRevision.current) return;
        setPreview(result); setPreviewError("");
      } catch (error) { if (revision === previewRevision.current) setPreviewError(error.message); }
    }, 350);
    return () => clearTimeout(timer);
  }, [previewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Both actions read the stored campaign and record their result on it, so a
  // draft that only exists on screen would produce an answer about a different
  // campaign. They stay disabled until the campaign is saved.
  const blocked = !draft?.id || unsaved;
  const unsavedHint = draft?.id ? "Save the campaign to test it: this sends the saved configuration, not the one on screen." : "Save the campaign before sending a test message.";
  const blockedNotice = { title: "Save the campaign first", description: !draft?.id ? "The campaign has to exist before it can be tested." : "This runs against the saved campaign, and the configuration on screen has not been saved yet.", variant: "warning" };
  const runValidation = async () => {
    if (blocked) return notify(blockedNotice);
    setValidating(true);
    try { const result = await postJson(`/api/contact-center/outbound-dialer/campaigns/${draft.id}/messaging/validate`, {}); setValidation({ at: result.validation.generated_at, counts: result.validation.counts, ok: result.validation.ok, limited: result.validation.limited, missing_by_variable: result.validation.missing_by_variable, problems: result.validation.problems }); }
    catch (error) { notify({ title: "Audience validation failed", description: error.message, variant: "error" }); }
    finally { setValidating(false); }
  };
  const sendTest = async () => {
    if (blocked) return notify(blockedNotice);
    if (!testTo.trim()) return notify({ title: "Enter a test destination", variant: "warning" });
    setTesting(true);
    try { const result = await postJson(`/api/contact-center/outbound-dialer/campaigns/${draft.id}/messaging/test-send`, { to: testTo, sample_index: sampleIndex }); notify({ title: result.result?.accepted ? "Test message accepted by Telnyx" : `Test message ${title(result.result?.state || "failed")}`, description: result.result?.reason ? title(result.result.reason) : result.result?.text, variant: result.result?.accepted ? "success" : "error" }); }
    catch (error) { notify({ title: "Test message failed", description: error.message, variant: "error" }); }
    finally { setTesting(false); }
  };

  const sampleTotal = preview?.sample?.total || 0;
  const previewBody = preview?.preview;
  const missingLabels = (requirements?.missing || []).map((key) => MESSAGING_REQUIREMENT_LABELS[key] || key);
  const consentField = config.consent.field;
  const selectedTemplateId = config.template[channel]?.template_id || "";

  return <div className="@container space-y-4">
    <PanelCard icon={IconSend} title="Sender" subtitle={SENDER_SUBTITLE[channel] || "Sender for this channel"} testId="messaging-sender-card">
      {channel === "sms" ? <div className="space-y-3">
        <FieldLabel required>FROM numbers</FieldLabel>
        {channelSenders.length ? <div className="grid gap-2 @[560px]:grid-cols-2">{channelSenders.map((sender) => { const checked = config.sender.sms.number_ids.includes(sender.id); const allowed = !(globalMessaging.senders?.sms_numbers || []).length || globalMessaging.senders.sms_numbers.includes(sender.id) || globalMessaging.senders.sms_numbers.includes(sender.phone_number); return <label key={sender.id} className={`flex items-start gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm ${!sender.sending_enabled || !allowed ? "opacity-60" : ""}`}><Checkbox checked={checked} disabled={!sender.sending_enabled || !allowed} onCheckedChange={(value) => setSender({ number_ids: value === true ? [...config.sender.sms.number_ids, sender.id] : config.sender.sms.number_ids.filter((id) => id !== sender.id) })} /><span className="min-w-0"><span className="block truncate font-medium">{sender.phone_number}</span><span className="block truncate text-[11px] text-muted-foreground">{sender.name}{sender.queue_name ? ` → ${sender.queue_name}` : ""}{!sender.sending_enabled ? " · sending paused" : ""}{!sender.routing_enabled ? " · replies not routed" : ""}{!allowed ? " · not allowed in Settings" : ""}</span></span></label>; })}</div>
          : <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">No SMS numbers are mapped yet. Map sending-enabled numbers under Admin → SMS → Numbers.</p>}
        <div className="space-y-2"><FieldLabel>Sender strategy</FieldLabel><Select value={config.sender.sms.strategy} onValueChange={(value) => setSender({ strategy: value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}>{SMS_SENDER_STRATEGIES.map((strategy) => <SelectItem key={strategy} value={strategy}><span className="block min-w-0 max-w-full truncate">{STRATEGY_LABELS[strategy]}</span></SelectItem>)}</SelectContent></Select></div>
      </div> : channel === "whatsapp" ? <div className="space-y-3">
        <FieldLabel required>FROM number</FieldLabel>
        {channelSenders.length ? <div className="grid gap-2 @[560px]:grid-cols-2">{channelSenders.map((sender) => { const allowed = !(globalMessaging.senders?.whatsapp_numbers || []).length || globalMessaging.senders.whatsapp_numbers.includes(sender.id) || globalMessaging.senders.whatsapp_numbers.includes(sender.phone_number); const disabled = !sender.sending_enabled || !allowed || !sender.messaging_profile_id; return <label key={sender.id} className={`flex items-start gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm ${disabled ? "opacity-60" : ""}`}><Checkbox checked={config.sender.whatsapp.number_id === sender.id} disabled={disabled} onCheckedChange={(value) => setSender({ number_id: value === true ? sender.id : "", waba_id: value === true ? sender.waba_id || "" : "" })} /><span className="min-w-0"><span className="block truncate font-medium">{sender.phone_number}</span><span className="block truncate text-[11px] text-muted-foreground">{sender.name}{sender.queue_name ? ` → ${sender.queue_name}` : ""}{sender.quality_rating ? ` · quality ${String(sender.quality_rating).toLowerCase()}` : ""}{!sender.sending_enabled ? " · sending paused" : ""}{!sender.messaging_profile_id ? " · no messaging profile" : ""}{!allowed ? " · not allowed in Settings" : ""}</span></span></label>; })}</div>
          : <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">No WhatsApp numbers are mapped yet. Map sending-enabled numbers under Admin → WhatsApp → Numbers.</p>}
        <p className="text-[11px] text-muted-foreground">A campaign message is business-initiated, so it always sends an approved template and the 24-hour customer service window does not apply. Replies open a conversation in the queue mapped to this number.</p>
      </div> : channel === "email" ? <div className="space-y-3">
        <FieldLabel required>FROM mailbox</FieldLabel>
        {channelSenders.length ? <div className="grid gap-2 @[560px]:grid-cols-2">{channelSenders.map((sender) => { const allowed = !(globalMessaging.senders?.email_mailboxes || []).length || globalMessaging.senders.email_mailboxes.includes(sender.id) || globalMessaging.senders.email_mailboxes.includes(sender.address); const disabled = !sender.sending_enabled || !allowed; return <label key={sender.id} className={`flex items-start gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm ${disabled ? "opacity-60" : ""}`}><Checkbox checked={config.sender.email.mailbox_id === sender.id} disabled={disabled} onCheckedChange={(value) => setSender({ mailbox_id: value === true ? sender.id : "" })} /><span className="min-w-0"><span className="block truncate font-medium">{sender.address}</span><span className="block truncate text-[11px] text-muted-foreground">{sender.name}{sender.queue_name ? ` → ${sender.queue_name}` : ""}{!sender.sending_enabled ? " · sending paused" : ""}{!allowed ? " · not allowed in Settings" : ""}</span></span></label>; })}</div>
          : <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">No mailboxes allow sending yet. Enable sending for a mailbox under Admin → Email → Mailboxes.</p>}
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <div className="space-y-2"><FieldLabel hint="Shown instead of the mailbox address in the recipient's inbox. Left empty, the workspace default from Dialer → Settings is used, then the mailbox name.">From name</FieldLabel><DraftTextInput value={config.sender.email.from_name} placeholder={globalMessaging.email?.default_from_name || "Contact Center"} onChange={(from_name) => setSender({ from_name })} /></div>
          <div className="space-y-2"><FieldLabel hint="Replies go here instead of the sending mailbox. Left empty, the workspace default from Dialer → Settings is used.">Reply-to</FieldLabel><DraftTextInput value={config.sender.email.reply_to} placeholder={globalMessaging.email?.default_reply_to || "replies@example.com"} onChange={(reply_to) => setSender({ reply_to })} /></div>
        </div>
      </div> : <p className="text-xs text-muted-foreground">Sender configuration for {title(channel)} arrives with that channel.</p>}
    </PanelCard>

    <PanelCard icon={IconUsers} title="Destination" subtitle="Which contact fields hold the address, in priority order, and how consent is checked" testId="messaging-destination-card">
      <div className="space-y-3">
        <div className="space-y-2"><FieldLabel required>Destination fields</FieldLabel>
          {destinationOptions.length ? <div className="grid gap-2 @[560px]:grid-cols-2">{destinationOptions.map((option) => { const index = config.destination_fields.indexOf(option.value); return <label key={option.value} className="flex items-center gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm"><Checkbox checked={index >= 0} onCheckedChange={(value) => setConfig({ destination_fields: value === true ? [...config.destination_fields, option.value] : config.destination_fields.filter((field) => field !== option.value) })} /><span className="min-w-0 flex-1 truncate">{option.label}</span>{index >= 0 ? <Badge variant="outline" className="font-mono text-[10px]">#{index + 1}</Badge> : null}</label>; })}</div>
            : <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">{list ? `The list has no ${channel === "email" ? "email" : "phone"} fields. Re-import it with a ${channel === "email" ? "Email" : "Number"} mapping.` : "Attach a contact list first."}</p>}
          <p className="text-[11px] text-muted-foreground">The first field with a valid address is used. Contact-method slots come from the CSV channel mapping.</p></div>
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <div className="space-y-2"><FieldLabel>Consent field</FieldLabel><Select value={consentField || "none"} onValueChange={(value) => setConfig({ consent: { ...config.consent, field: value === "none" ? "" : value } })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue placeholder="No consent check" /></SelectTrigger><SelectContent className={SELECT_CONTENT}><SelectItem value="none">No consent check</SelectItem>{fields.map((field) => <SelectItem key={field} value={field}><span className="block min-w-0 max-w-full truncate">{field}</span></SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><FieldLabel>Accepted values</FieldLabel><DraftTextInput value={config.consent.accepted_values.join(", ")} disabled={!consentField} placeholder="yes, opted_in" onChange={(raw) => setConfig({ consent: { ...config.consent, accepted_values: raw.split(",").map((value) => value.trim()).filter(Boolean) } })} /></div>
        </div>
      </div>
    </PanelCard>

    <PanelCard icon={IconTemplate} title="Message" subtitle="Template, variable mapping and a preview rendered for a real contact" testId="messaging-message-card">
      <div className="space-y-3">
          <div className="space-y-2"><FieldLabel required>Template</FieldLabel><Select value={selectedTemplateId || "none"} onValueChange={(value) => setTemplate({ template_id: value === "none" ? "" : value })}><SelectTrigger className={SELECT_TRIGGER} data-testid="messaging-template-select"><SelectValue placeholder="Select a template" /></SelectTrigger><SelectContent className={SELECT_CONTENT}><SelectItem value="none">Not selected</SelectItem>{channelTemplates.map((item) => <SelectItem key={item.id} value={item.id}><span className="block min-w-0 max-w-full truncate">{[item.name, item.language, channel === "email" ? item.subject : item.category].filter(Boolean).join(" · ")}</span></SelectItem>)}</SelectContent></Select>
            {!channelTemplates.length ? <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">{TEMPLATE_SOURCE[channel] || "No templates available"}</p> : null}
            {template ? <p className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/20 p-3 text-xs [overflow-wrap:anywhere]" data-testid="messaging-template-body">{template.body}</p> : null}</div>
          {channel === "email" ? <div className="grid gap-3 @[480px]:grid-cols-2"><div className="space-y-2"><FieldLabel hint="Replaces the template subject for this campaign. Variables are allowed.">Subject override</FieldLabel><DraftTextInput data-testid="messaging-subject-override" value={config.template.email.subject_override} placeholder={template?.subject || "Keep the template subject"} onChange={(subject_override) => setTemplate({ subject_override })} /></div>
            <div className="space-y-2"><FieldLabel>When a variable has no value</FieldLabel><Select value={config.missing_variable_policy} onValueChange={(value) => setConfig({ missing_variable_policy: value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}>{MISSING_VARIABLE_POLICIES.map((policy) => <SelectItem key={policy} value={policy}><span className="block min-w-0 max-w-full truncate">{POLICY_LABELS[policy]}</span></SelectItem>)}</SelectContent></Select></div></div> : null}
          {channel === "whatsapp" ? <div className="grid gap-3 @[480px]:grid-cols-2">
            {MEDIA_HEADER_FORMATS.includes(String(template?.header_format || "").toUpperCase()) ? <div className="space-y-2"><FieldLabel required hint="Public HTTPS link to the header media Meta renders above the template body.">Header {String(template.header_format).toLowerCase()} URL</FieldLabel><DraftTextInput value={config.template.whatsapp.header_media?.url || ""} placeholder="https://example.com/banner.jpg" onChange={(url) => setTemplate({ header_media: { type: String(template.header_format).toLowerCase(), url, media_id: "", filename: config.template.whatsapp.header_media?.filename || "" } })} /></div> : null}
            <div className="space-y-2"><FieldLabel>When a variable has no value</FieldLabel><Select value={config.missing_variable_policy} onValueChange={(value) => setConfig({ missing_variable_policy: value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}>{MISSING_VARIABLE_POLICIES.map((policy) => <SelectItem key={policy} value={policy}><span className="block min-w-0 max-w-full truncate">{POLICY_LABELS[policy]}</span></SelectItem>)}</SelectContent></Select></div></div> : null}
          {channel === "sms" ? <div className="grid gap-3 @[480px]:grid-cols-2"><div className="space-y-2"><FieldLabel>Opt-out footer</FieldLabel><Select value={config.template.sms.footer_mode} onValueChange={(value) => setTemplate({ footer_mode: value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}><SelectItem value="inherit">Append footer</SelectItem><SelectItem value="none">{globalMessaging.sms?.require_opt_out_footer === false ? "No footer" : "No footer (unless required)"}</SelectItem></SelectContent></Select>{globalMessaging.sms?.require_opt_out_footer === false ? null : <p className="text-[11px] text-muted-foreground" data-testid="messaging-footer-note">Dialer &rarr; Settings requires an opt-out footer, so it is appended even when this is set to no footer.</p>}</div>
            <div className="space-y-2"><FieldLabel>When a variable has no value</FieldLabel><Select value={config.missing_variable_policy} onValueChange={(value) => setConfig({ missing_variable_policy: value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}>{MISSING_VARIABLE_POLICIES.map((policy) => <SelectItem key={policy} value={policy}><span className="block min-w-0 max-w-full truncate">{POLICY_LABELS[policy]}</span></SelectItem>)}</SelectContent></Select></div></div> : null}
          <div className="space-y-2">
            <div className="flex items-center justify-between"><FieldLabel required={templateVariables.length > 0}>Variable mapping</FieldLabel><Button type="button" size="sm" variant="outline" disabled={!templateVariables.length || !fields.length} onClick={() => setConfig({ variable_mapping: autoMapVariables(templateVariables, fields, mapping) })}><IconWand className="mr-1 h-3.5 w-3.5" />Auto-map</Button></div>
            {templateVariables.length ? <div className="overflow-hidden rounded-xl border bg-background/70 text-sm"><div className={MAPPING_HEADER_CLASS}><span>Variable</span><span>Source</span><span>Value</span><span>Fallback</span></div>
              {mapping.map((row) => <div key={row.key} className={MAPPING_ROW_CLASS} data-testid={`messaging-mapping-${row.key}`}>
                <span className="truncate font-mono text-xs @[720px]:py-2">{`{{${row.key}}}`}</span>
                <MappingField label="Source"><Select value={row.source} onValueChange={(value) => updateRow(row.key, { source: value, value: "" })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}>{VARIABLE_SOURCES.map((source) => <SelectItem key={source} value={source}><span className="block min-w-0 max-w-full truncate">{SOURCE_LABELS[source]}</span></SelectItem>)}</SelectContent></Select></MappingField>
                <MappingField label="Value">{row.source === "static" ? <DraftTextInput className="h-9 min-w-0" value={row.value} onChange={(value) => updateRow(row.key, { value })} placeholder="Text" />
                  : <Select value={row.value || "__none__"} onValueChange={(value) => updateRow(row.key, { value: value === "__none__" ? "" : value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue placeholder="Select" /></SelectTrigger><SelectContent className={SELECT_CONTENT}><SelectItem value="__none__">Not mapped</SelectItem>{(row.source === "contact_field" ? fields : row.source === "contact_method" ? slots : SYSTEM_VARIABLES.map((v) => v.key)).map((value) => <SelectItem key={value} value={value}><span className="block min-w-0 max-w-full truncate">{row.source === "system" ? SYSTEM_VARIABLES.find((v) => v.key === value)?.label || value : value}</span></SelectItem>)}</SelectContent></Select>}</MappingField>
                <MappingField label="Fallback"><DraftTextInput className="h-9 min-w-0" value={row.fallback} onChange={(fallback) => updateRow(row.key, { fallback })} placeholder="Optional" /></MappingField>
              </div>)}</div>
              : <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">{template ? "This template has no variables." : "Select a template to map its variables."}</p>}
          </div>
          <div className="rounded-lg border bg-muted/20 p-3 text-xs" data-testid="messaging-preview-status">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">Preview contact</span><div className="flex items-center gap-1"><Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Previous sample contact" data-testid="messaging-sample-prev" disabled={sampleIndex === 0} onClick={() => setSampleIndex((index) => Math.max(0, index - 1))}><IconChevronLeft className="h-4 w-4" /></Button><span className="tabular-nums text-muted-foreground">{sampleTotal ? `${Math.min(sampleIndex + 1, sampleTotal)} / ${sampleTotal}` : "—"}</span><Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Next sample contact" data-testid="messaging-sample-next" disabled={!sampleTotal || sampleIndex + 1 >= sampleTotal} onClick={() => setSampleIndex((index) => index + 1)}><IconChevronRight className="h-4 w-4" /></Button></div></div>
            {previewError ? <p className="mt-2 text-destructive">{previewError}</p> : previewBody ? <div className="mt-2 space-y-1"><p>To: <span className="font-mono">{previewBody.destination?.address || "no valid address"}</span>{previewBody.destination?.field ? <span className="text-muted-foreground"> ({previewBody.destination.field})</span> : null}</p>{previewBody.segments ? <p>{describeSmsSegments(previewBody.segments)} · {previewBody.segments.chars} characters</p> : null}{previewBody.warnings?.length ? <ul className="list-disc space-y-0.5 pl-4 text-amber-700 dark:text-amber-300">{previewBody.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p className="text-emerald-700 dark:text-emerald-300">Ready to send for this contact.</p>}{previewBody.text ? <p className="whitespace-pre-wrap rounded-lg border bg-background/70 p-3 [overflow-wrap:anywhere]" data-testid="messaging-preview-text">{previewBody.text}</p> : null}</div> : <p className="mt-2 text-muted-foreground">{draft?.contact_list_id && selectedTemplateId ? "Rendering…" : "Attach a contact list and select a template to preview."}</p>}
          </div>
          <div className="grid gap-3 @[480px]:grid-cols-2">
            <div className="space-y-2"><FieldLabel>Send a test message</FieldLabel><div className="flex gap-2"><Input className="min-w-0" value={testTo} placeholder={channel === "email" ? "name@example.com" : "+48 600 000 000"} onChange={(e) => setTestTo(e.target.value)} /><Button type="button" size="sm" disabled={testing || saving || blocked} onClick={sendTest} data-testid="messaging-test-send"><IconSend className="mr-1 h-3.5 w-3.5" />Send</Button></div><p className="text-[11px] text-muted-foreground" data-testid="messaging-test-hint">{blocked ? unsavedHint : "Uses the values of the preview contact. Test-mode allowlists apply."}</p></div>
            <div className="space-y-2"><FieldLabel>Audience validation</FieldLabel><Button type="button" size="sm" variant="outline" disabled={validating || saving || blocked} onClick={runValidation} data-testid="messaging-validate"><IconListCheck className="mr-1 h-3.5 w-3.5" />{validating ? "Validating…" : "Validate audience"}</Button>
              {validation?.counts ? <div className="rounded-lg border bg-background/70 p-2 text-[11px]" data-testid="messaging-validation"><div className="font-medium">{validation.counts.sendable.toLocaleString()} of {validation.counts.total.toLocaleString()} contacts sendable{validation.limited ? " (first 10,000 scanned)" : ""}</div><div className="text-muted-foreground">{[["missing address", validation.counts.missing_destination], ["filtered out", validation.counts.filtered_out], ["DNC", validation.counts.dnc], ["opted out", validation.counts.opted_out], ["no consent", validation.counts.consent_missing], ["outside the test-mode allowlist", validation.counts.test_mode_allowlist], ["missing variables", validation.counts.missing_variables], ["too long", validation.counts.too_many_segments], ["not valid", validation.counts.not_valid]].filter(([, count]) => count).map(([label, count]) => `${count} ${label}`).join(" · ") || "No problems found"}{validation.counts.estimated_parts ? ` · ≈${validation.counts.estimated_parts.toLocaleString()} SMS parts` : ""}</div>{validation.at ? <div className="text-muted-foreground">Checked {new Date(validation.at).toLocaleString()}</div> : null}</div> : <p className="text-[11px] text-muted-foreground" data-testid="messaging-validate-hint">{blocked ? (draft?.id ? "Save the campaign to validate it: this counts the saved configuration, not the one on screen." : "Save the campaign before validating its audience.") : "Counts what the runner would send, suppress or skip."}</p>}</div>
          </div>
      </div>
    </PanelCard>

    <PanelCard icon={IconMessage} title="Delivery strategy" subtitle="Broadcast pacing. Campaign values may only tighten the workspace limits in Settings → Messaging campaigns." testId="messaging-pacing-card">
      <div className="grid gap-3 @[480px]:grid-cols-2">
        <NumberField label={`Max per minute (workspace ${pacing.max_per_minute})`} min={1} max={pacing.max_per_minute} value={config.pacing.max_per_minute} onChange={(value) => setConfig({ pacing: { ...config.pacing, max_per_minute: value } })} />
        <NumberField label={`Batch size (workspace ${globalMessaging.batch?.max_messages_per_batch ?? pacing.batch_size})`} min={1} max={globalMessaging.batch?.max_messages_per_batch ?? 500} value={config.pacing.batch_size} onChange={(value) => setConfig({ pacing: { ...config.pacing, batch_size: value } })} />
        <NumberField label={`Max in flight (workspace ${globalMessaging.batch?.max_in_flight_per_campaign ?? pacing.max_in_flight})`} min={1} max={globalMessaging.batch?.max_in_flight_per_campaign ?? 5000} value={config.pacing.max_in_flight} onChange={(value) => setConfig({ pacing: { ...config.pacing, max_in_flight: value } })} hint="Messages accepted by Telnyx without delivery evidence yet." />
        <NumberField label="Max attempts per contact" min={1} max={globalMessaging.attempts?.max_attempts_per_contact ?? 100} value={draft?.retry_policy?.maxAttempts ?? null} onChange={(value) => update({ retry_policy: { ...(draft?.retry_policy || {}), maxAttempts: value == null ? undefined : Math.max(1, value) } })} hint="Only transient failures are retried; a delivered message ends the contact." />
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">Effective now: {pacing.max_per_minute}/min · batches of {pacing.batch_size} every {pacing.batch_interval_seconds}s · {pacing.max_in_flight} in flight · {pacing.max_per_hour}/h · {pacing.max_per_day}/day.</p>
    </PanelCard>

    {missingLabels.length ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300" data-testid="messaging-requirements"><IconSparkles className="mr-1 inline h-3.5 w-3.5" />Required before saving: {missingLabels.join(", ")}.</div> : null}
  </div>;
}
