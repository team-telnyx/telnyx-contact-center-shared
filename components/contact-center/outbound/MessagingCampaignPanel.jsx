"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

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
  const tUi = useUiText();
  return <div className="rounded-2xl border bg-background/85 p-4 shadow-sm" data-testid={testId}><div className="mb-4 flex items-start gap-3"><span className="rounded-xl bg-gradient-to-br from-sky-500/15 to-violet-500/15 p-2 text-sky-600"><Icon className="h-4 w-4" /></span><div><h3 className="text-sm font-semibold">{cardTitle}</h3><p className="text-xs text-muted-foreground">{tUi(subtitle)}</p></div></div>{children}</div>;
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
  const tUi = useUiText();
  return <div className="min-w-0 space-y-2"><FieldLabel hint={hint}>{label}</FieldLabel><Input type="number" min={min} max={max} value={value ?? ""} placeholder={tUi("inherit")} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} /></div>;
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
  const tUi = useUiText();
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
    try { const result = await postJson(`/api/contact-center/outbound-dialer/campaigns/${draft.id}/messaging/test-send`, { to: testTo, sample_index: sampleIndex }); notify({ title: result.result?.accepted ? "Test message accepted by Telnyx" : tUi("Test message {value0}", {value0: title(result.result?.state || "failed")}), description: result.result?.reason ? title(result.result.reason) : result.result?.text, variant: result.result?.accepted ? "success" : "error" }); }
    catch (error) { notify({ title: "Test message failed", description: error.message, variant: "error" }); }
    finally { setTesting(false); }
  };

  const sampleTotal = preview?.sample?.total || 0;
  const previewBody = preview?.preview;
  const missingLabels = (requirements?.missing || []).map((key) => MESSAGING_REQUIREMENT_LABELS[key] || key);
  const consentField = config.consent.field;
  const selectedTemplateId = config.template[channel]?.template_id || "";

  return <div className="@container space-y-4">
    <PanelCard icon={IconSend} title={tUi("Sender")} subtitle={tUi(SENDER_SUBTITLE[channel] || "Sender for this channel")} testId="messaging-sender-card">
      {channel === "sms" ? <div className="space-y-3">
        <FieldLabel required>{tUi("FROM numbers")}</FieldLabel>
        {channelSenders.length ? <div className="grid gap-2 @[560px]:grid-cols-2">{channelSenders.map((sender) => { const checked = config.sender.sms.number_ids.includes(sender.id); const allowed = !(globalMessaging.senders?.sms_numbers || []).length || globalMessaging.senders.sms_numbers.includes(sender.id) || globalMessaging.senders.sms_numbers.includes(sender.phone_number); return <label key={sender.id} className={`flex items-start gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm ${!sender.sending_enabled || !allowed ? "opacity-60" : ""}`}><Checkbox checked={checked} disabled={!sender.sending_enabled || !allowed} onCheckedChange={(value) => setSender({ number_ids: value === true ? [...config.sender.sms.number_ids, sender.id] : config.sender.sms.number_ids.filter((id) => id !== sender.id) })} /><span className="min-w-0"><span className="block truncate font-medium">{sender.phone_number}</span><span className="block truncate text-[11px] text-muted-foreground">{sender.name}{sender.queue_name ? tUi(" → {value0}", { value0: sender.queue_name }) : ""}{!sender.sending_enabled ? tUi(" · sending paused") : ""}{!sender.routing_enabled ? tUi(" · replies not routed") : ""}{!allowed ? tUi(" · not allowed in Settings") : ""}</span></span></label>; })}</div>
          : <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">{tUi("No SMS numbers are mapped yet. Map sending-enabled numbers under Admin → SMS → Numbers.")}</p>}
        <div className="space-y-2"><FieldLabel>{tUi("Sender strategy")}</FieldLabel><Select value={config.sender.sms.strategy} onValueChange={(value) => setSender({ strategy: value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}>{SMS_SENDER_STRATEGIES.map((strategy) => <SelectItem key={strategy} value={strategy}><span className="block min-w-0 max-w-full truncate">{tUi(STRATEGY_LABELS[strategy])}</span></SelectItem>)}</SelectContent></Select></div>
      </div> : channel === "whatsapp" ? <div className="space-y-3">
        <FieldLabel required>{tUi("FROM number")}</FieldLabel>
        {channelSenders.length ? <div className="grid gap-2 @[560px]:grid-cols-2">{channelSenders.map((sender) => { const allowed = !(globalMessaging.senders?.whatsapp_numbers || []).length || globalMessaging.senders.whatsapp_numbers.includes(sender.id) || globalMessaging.senders.whatsapp_numbers.includes(sender.phone_number); const disabled = !sender.sending_enabled || !allowed || !sender.messaging_profile_id; return <label key={sender.id} className={`flex items-start gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm ${disabled ? "opacity-60" : ""}`}><Checkbox checked={config.sender.whatsapp.number_id === sender.id} disabled={disabled} onCheckedChange={(value) => setSender({ number_id: value === true ? sender.id : "", waba_id: value === true ? sender.waba_id || "" : "" })} /><span className="min-w-0"><span className="block truncate font-medium">{sender.phone_number}</span><span className="block truncate text-[11px] text-muted-foreground">{sender.name}{sender.queue_name ? tUi(" → {value0}", { value0: sender.queue_name }) : ""}{sender.quality_rating ? tUi(" · quality {value0}", { value0: String(sender.quality_rating).toLowerCase() }) : ""}{!sender.sending_enabled ? tUi(" · sending paused") : ""}{!sender.messaging_profile_id ? tUi(" · no messaging profile") : ""}{!allowed ? tUi(" · not allowed in Settings") : ""}</span></span></label>; })}</div>
          : <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">{tUi("No WhatsApp numbers are mapped yet. Map sending-enabled numbers under Admin → WhatsApp → Numbers.")}</p>}
        <p className="text-[11px] text-muted-foreground">{tUi("A campaign message is business-initiated, so it always sends an approved template and the 24-hour customer service window does not apply. Replies open a conversation in the queue mapped to this number.")}</p>
      </div> : channel === "email" ? <div className="space-y-3">
        <FieldLabel required>{tUi("FROM mailbox")}</FieldLabel>
        {channelSenders.length ? <div className="grid gap-2 @[560px]:grid-cols-2">{channelSenders.map((sender) => { const allowed = !(globalMessaging.senders?.email_mailboxes || []).length || globalMessaging.senders.email_mailboxes.includes(sender.id) || globalMessaging.senders.email_mailboxes.includes(sender.address); const disabled = !sender.sending_enabled || !allowed; return <label key={sender.id} className={`flex items-start gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm ${disabled ? "opacity-60" : ""}`}><Checkbox checked={config.sender.email.mailbox_id === sender.id} disabled={disabled} onCheckedChange={(value) => setSender({ mailbox_id: value === true ? sender.id : "" })} /><span className="min-w-0"><span className="block truncate font-medium">{sender.address}</span><span className="block truncate text-[11px] text-muted-foreground">{sender.name}{sender.queue_name ? tUi(" → {value0}", { value0: sender.queue_name }) : ""}{!sender.sending_enabled ? tUi(" · sending paused") : ""}{!allowed ? tUi(" · not allowed in Settings") : ""}</span></span></label>; })}</div>
          : <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">{tUi("No mailboxes allow sending yet. Enable sending for a mailbox under Admin → Email → Mailboxes.")}</p>}
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <div className="space-y-2"><FieldLabel hint={tUi("Shown instead of the mailbox address in the recipient's inbox. Left empty, the workspace default from Dialer → Settings is used, then the mailbox name.")}>{tUi("From name")}</FieldLabel><DraftTextInput value={config.sender.email.from_name} placeholder={globalMessaging.email?.default_from_name || tUi("Contact Center")} onChange={(from_name) => setSender({ from_name })} /></div>
          <div className="space-y-2"><FieldLabel hint={tUi("Replies go here instead of the sending mailbox. Left empty, the workspace default from Dialer → Settings is used.")}>{tUi("Reply-to")}</FieldLabel><DraftTextInput value={config.sender.email.reply_to} placeholder={globalMessaging.email?.default_reply_to || tUi("replies@example.com")} onChange={(reply_to) => setSender({ reply_to })} /></div>
        </div>
      </div> : <p className="text-xs text-muted-foreground">{tUi("Sender configuration for ")}{title(channel)}{tUi(" arrives with that channel.")}</p>}
    </PanelCard>

    <PanelCard icon={IconUsers} title={tUi("Destination")} subtitle={tUi("Which contact fields hold the address, in priority order, and how consent is checked")} testId="messaging-destination-card">
      <div className="space-y-3">
        <div className="space-y-2"><FieldLabel required>{tUi("Destination fields")}</FieldLabel>
          {destinationOptions.length ? <div className="grid gap-2 @[560px]:grid-cols-2">{destinationOptions.map((option) => { const index = config.destination_fields.indexOf(option.value); return <label key={option.value} className="flex items-center gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm"><Checkbox checked={index >= 0} onCheckedChange={(value) => setConfig({ destination_fields: value === true ? [...config.destination_fields, option.value] : config.destination_fields.filter((field) => field !== option.value) })} /><span className="min-w-0 flex-1 truncate">{option.label}</span>{index >= 0 ? <Badge variant="outline" className="font-mono text-[10px]">#{index + 1}</Badge> : null}</label>; })}</div>
            : <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">{list ? `The list has no ${channel === "email" ? "email" : "phone"} fields. Re-import it with a ${channel === "email" ? "Email" : "Number"} mapping.` : tUi("Attach a contact list first.")}</p>}
          <p className="text-[11px] text-muted-foreground">{tUi("The first field with a valid address is used. Contact-method slots come from the CSV channel mapping.")}</p></div>
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <div className="space-y-2"><FieldLabel>{tUi("Consent field")}</FieldLabel><Select value={consentField || "none"} onValueChange={(value) => setConfig({ consent: { ...config.consent, field: value === "none" ? "" : value } })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue placeholder={tUi("No consent check")} /></SelectTrigger><SelectContent className={SELECT_CONTENT}><SelectItem value="none">{tUi("No consent check")}</SelectItem>{fields.map((field) => <SelectItem key={field} value={field}><span className="block min-w-0 max-w-full truncate">{field}</span></SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><FieldLabel>{tUi("Accepted values")}</FieldLabel><DraftTextInput value={config.consent.accepted_values.join(", ")} disabled={!consentField} placeholder={tUi("yes, opted_in")} onChange={(raw) => setConfig({ consent: { ...config.consent, accepted_values: raw.split(",").map((value) => value.trim()).filter(Boolean) } })} /></div>
        </div>
      </div>
    </PanelCard>

    <PanelCard icon={IconTemplate} title={tUi("Message")} subtitle={tUi("Template, variable mapping and a preview rendered for a real contact")} testId="messaging-message-card">
      <div className="space-y-3">
          <div className="space-y-2"><FieldLabel required>{tUi("Template")}</FieldLabel><Select value={selectedTemplateId || "none"} onValueChange={(value) => setTemplate({ template_id: value === "none" ? "" : value })}><SelectTrigger className={SELECT_TRIGGER} data-testid="messaging-template-select"><SelectValue placeholder={tUi("Select a template")} /></SelectTrigger><SelectContent className={SELECT_CONTENT}><SelectItem value="none">{tUi("Not selected")}</SelectItem>{channelTemplates.map((item) => <SelectItem key={item.id} value={item.id}><span className="block min-w-0 max-w-full truncate">{[item.name, item.language, channel === "email" ? item.subject : item.category].filter(Boolean).join(" · ")}</span></SelectItem>)}</SelectContent></Select>
            {!channelTemplates.length ? <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">{tUi(TEMPLATE_SOURCE[channel] || tUi("No templates available"))}</p> : null}
            {template ? <p className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/20 p-3 text-xs [overflow-wrap:anywhere]" data-testid="messaging-template-body">{template.body}</p> : null}</div>
          {channel === "email" ? <div className="grid gap-3 @[480px]:grid-cols-2"><div className="space-y-2"><FieldLabel hint={tUi("Replaces the template subject for this campaign. Variables are allowed.")}>{tUi("Subject override")}</FieldLabel><DraftTextInput data-testid="messaging-subject-override" value={config.template.email.subject_override} placeholder={template?.subject || tUi("Keep the template subject")} onChange={(subject_override) => setTemplate({ subject_override })} /></div>
            <div className="space-y-2"><FieldLabel>{tUi("When a variable has no value")}</FieldLabel><Select value={config.missing_variable_policy} onValueChange={(value) => setConfig({ missing_variable_policy: value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}>{MISSING_VARIABLE_POLICIES.map((policy) => <SelectItem key={policy} value={policy}><span className="block min-w-0 max-w-full truncate">{tUi(POLICY_LABELS[policy])}</span></SelectItem>)}</SelectContent></Select></div></div> : null}
          {channel === "whatsapp" ? <div className="grid gap-3 @[480px]:grid-cols-2">
            {MEDIA_HEADER_FORMATS.includes(String(template?.header_format || "").toUpperCase()) ? <div className="space-y-2"><FieldLabel required hint={tUi("Public HTTPS link to the header media Meta renders above the template body.")}>{tUi("Header ")}{String(template.header_format).toLowerCase()}{tUi(" URL")}</FieldLabel><DraftTextInput value={config.template.whatsapp.header_media?.url || ""} placeholder="https://example.com/banner.jpg" onChange={(url) => setTemplate({ header_media: { type: String(template.header_format).toLowerCase(), url, media_id: "", filename: config.template.whatsapp.header_media?.filename || "" } })} /></div> : null}
            <div className="space-y-2"><FieldLabel>{tUi("When a variable has no value")}</FieldLabel><Select value={config.missing_variable_policy} onValueChange={(value) => setConfig({ missing_variable_policy: value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}>{MISSING_VARIABLE_POLICIES.map((policy) => <SelectItem key={policy} value={policy}><span className="block min-w-0 max-w-full truncate">{tUi(POLICY_LABELS[policy])}</span></SelectItem>)}</SelectContent></Select></div></div> : null}
          {channel === "sms" ? <div className="grid gap-3 @[480px]:grid-cols-2"><div className="space-y-2"><FieldLabel>{tUi("Opt-out footer")}</FieldLabel><Select value={config.template.sms.footer_mode} onValueChange={(value) => setTemplate({ footer_mode: value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}><SelectItem value="inherit">{tUi("Append footer")}</SelectItem><SelectItem value="none">{globalMessaging.sms?.require_opt_out_footer === false ? tUi("No footer") : tUi("No footer (unless required)")}</SelectItem></SelectContent></Select>{globalMessaging.sms?.require_opt_out_footer === false ? null : <p className="text-[11px] text-muted-foreground" data-testid="messaging-footer-note">{tUi("Dialer → Settings requires an opt-out footer, so it is appended even when this is set to no footer.")}</p>}</div>
            <div className="space-y-2"><FieldLabel>{tUi("When a variable has no value")}</FieldLabel><Select value={config.missing_variable_policy} onValueChange={(value) => setConfig({ missing_variable_policy: value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}>{MISSING_VARIABLE_POLICIES.map((policy) => <SelectItem key={policy} value={policy}><span className="block min-w-0 max-w-full truncate">{tUi(POLICY_LABELS[policy])}</span></SelectItem>)}</SelectContent></Select></div></div> : null}
          <div className="space-y-2">
            <div className="flex items-center justify-between"><FieldLabel required={templateVariables.length > 0}>{tUi("Variable mapping")}</FieldLabel><Button type="button" size="sm" variant="outline" disabled={!templateVariables.length || !fields.length} onClick={() => setConfig({ variable_mapping: autoMapVariables(templateVariables, fields, mapping) })}><IconWand className="mr-1 h-3.5 w-3.5" />{tUi("Auto-map")}</Button></div>
            {templateVariables.length ? <div className="overflow-hidden rounded-xl border bg-background/70 text-sm"><div className={MAPPING_HEADER_CLASS}><span>{tUi("Variable")}</span><span>{tUi("Source")}</span><span>{tUi("Value")}</span><span>{tUi("Fallback")}</span></div>
              {mapping.map((row) => <div key={row.key} className={MAPPING_ROW_CLASS} data-testid={`messaging-mapping-${row.key}`}>
                <span className="truncate font-mono text-xs @[720px]:py-2">{`{{${row.key}}}`}</span>
                <MappingField label={tUi("Source")}><Select value={row.source} onValueChange={(value) => updateRow(row.key, { source: value, value: "" })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue /></SelectTrigger><SelectContent className={SELECT_CONTENT}>{VARIABLE_SOURCES.map((source) => <SelectItem key={source} value={source}><span className="block min-w-0 max-w-full truncate">{tUi(SOURCE_LABELS[source])}</span></SelectItem>)}</SelectContent></Select></MappingField>
                <MappingField label={tUi("Value")}>{row.source === "static" ? <DraftTextInput className="h-9 min-w-0" value={row.value} onChange={(value) => updateRow(row.key, { value })} placeholder={tUi("Text")} />
                  : <Select value={row.value || "__none__"} onValueChange={(value) => updateRow(row.key, { value: value === "__none__" ? "" : value })}><SelectTrigger className={SELECT_TRIGGER}><SelectValue placeholder={tUi("Select")} /></SelectTrigger><SelectContent className={SELECT_CONTENT}><SelectItem value="__none__">{tUi("Not mapped")}</SelectItem>{(row.source === "contact_field" ? fields : row.source === "contact_method" ? slots : SYSTEM_VARIABLES.map((v) => v.key)).map((value) => <SelectItem key={value} value={value}><span className="block min-w-0 max-w-full truncate">{row.source === "system" ? (SYSTEM_VARIABLES.find((v) => v.key === value)?.label ? tUi(SYSTEM_VARIABLES.find((v) => v.key === value).label) : value) : value}</span></SelectItem>)}</SelectContent></Select>}</MappingField>
                <MappingField label={tUi("Fallback")}><DraftTextInput className="h-9 min-w-0" value={row.fallback} onChange={(fallback) => updateRow(row.key, { fallback })} placeholder={tUi("Optional")} /></MappingField>
              </div>)}</div>
              : <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">{template ? tUi("This template has no variables.") : tUi("Select a template to map its variables.")}</p>}
          </div>
          <div className="rounded-lg border bg-muted/20 p-3 text-xs" data-testid="messaging-preview-status">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{tUi("Preview contact")}</span><div className="flex items-center gap-1"><Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={tUi("Previous sample contact")} data-testid="messaging-sample-prev" disabled={sampleIndex === 0} onClick={() => setSampleIndex((index) => Math.max(0, index - 1))}><IconChevronLeft className="h-4 w-4" /></Button><span className="tabular-nums text-muted-foreground">{sampleTotal ? `${Math.min(sampleIndex + 1, sampleTotal)} / ${sampleTotal}` : "—"}</span><Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={tUi("Next sample contact")} data-testid="messaging-sample-next" disabled={!sampleTotal || sampleIndex + 1 >= sampleTotal} onClick={() => setSampleIndex((index) => index + 1)}><IconChevronRight className="h-4 w-4" /></Button></div></div>
            {previewError ? <p className="mt-2 text-destructive">{previewError}</p> : previewBody ? <div className="mt-2 space-y-1"><p>{tUi("To: ")}<span className="font-mono">{previewBody.destination?.address || tUi("no valid address")}</span>{previewBody.destination?.field ? <span className="text-muted-foreground"> ({previewBody.destination.field})</span> : null}</p>{previewBody.segments ? <p>{describeSmsSegments(previewBody.segments, tUi)} · {previewBody.segments.chars}{tUi(" characters")}</p> : null}{previewBody.warnings?.length ? <ul className="list-disc space-y-0.5 pl-4 text-amber-700 dark:text-amber-300">{previewBody.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p className="text-emerald-700 dark:text-emerald-300">{tUi("Ready to send for this contact.")}</p>}{previewBody.text ? <p className="whitespace-pre-wrap rounded-lg border bg-background/70 p-3 [overflow-wrap:anywhere]" data-testid="messaging-preview-text">{previewBody.text}</p> : null}</div> : <p className="mt-2 text-muted-foreground">{draft?.contact_list_id && selectedTemplateId ? tUi("Rendering…") : tUi("Attach a contact list and select a template to preview.")}</p>}
          </div>
          <div className="grid gap-3 @[480px]:grid-cols-2">
            <div className="space-y-2"><FieldLabel>{tUi("Send a test message")}</FieldLabel><div className="flex gap-2"><Input className="min-w-0" value={testTo} placeholder={channel === "email" ? tUi("name@example.com") : "+48 600 000 000"} onChange={(e) => setTestTo(e.target.value)} /><Button type="button" size="sm" disabled={testing || saving || blocked} onClick={sendTest} data-testid="messaging-test-send"><IconSend className="mr-1 h-3.5 w-3.5" />{tUi("Send")}</Button></div><p className="text-[11px] text-muted-foreground" data-testid="messaging-test-hint">{tUi(blocked ? unsavedHint : tUi("Uses the values of the preview contact. Test-mode allowlists apply."))}</p></div>
            <div className="space-y-2"><FieldLabel>{tUi("Audience validation")}</FieldLabel><Button type="button" size="sm" variant="outline" disabled={validating || saving || blocked} onClick={runValidation} data-testid="messaging-validate"><IconListCheck className="mr-1 h-3.5 w-3.5" />{validating ? tUi("Validating…") : tUi("Validate audience")}</Button>
              {validation?.counts ? <div className="rounded-lg border bg-background/70 p-2 text-[11px]" data-testid="messaging-validation"><div className="font-medium">{validation.counts.sendable.toLocaleString(tUi.locale)}{tUi(" of ")}{validation.counts.total.toLocaleString(tUi.locale)}{tUi(" contacts sendable")}{validation.limited ? tUi(" (first 10,000 scanned)") : ""}</div><div className="text-muted-foreground">{[["missing address", validation.counts.missing_destination], ["filtered out", validation.counts.filtered_out], ["DNC", validation.counts.dnc], ["opted out", validation.counts.opted_out], ["no consent", validation.counts.consent_missing], ["outside the test-mode allowlist", validation.counts.test_mode_allowlist], ["missing variables", validation.counts.missing_variables], ["too long", validation.counts.too_many_segments], ["not valid", validation.counts.not_valid]].filter(([, count]) => count).map(([label, count]) => `${count} ${label}`).join(" · ") || tUi("No problems found")}{validation.counts.estimated_parts ? tUi(" · ≈{value0} SMS parts", { value0: validation.counts.estimated_parts.toLocaleString(tUi.locale) }) : ""}</div>{validation.at ? <div className="text-muted-foreground">{tUi("Checked ")}{new Date(validation.at).toLocaleString(tUi.locale)}</div> : null}</div> : <p className="text-[11px] text-muted-foreground" data-testid="messaging-validate-hint">{blocked ? (draft?.id ? tUi("Save the campaign to validate it: this counts the saved configuration, not the one on screen.") : tUi("Save the campaign before validating its audience.")) : tUi("Counts what the runner would send, suppress or skip.")}</p>}</div>
          </div>
      </div>
    </PanelCard>

    <PanelCard icon={IconMessage} title={tUi("Delivery strategy")} subtitle={tUi("Broadcast pacing. Campaign values may only tighten the workspace limits in Settings → Messaging campaigns.")} testId="messaging-pacing-card">
      <div className="grid gap-3 @[480px]:grid-cols-2">
        <NumberField label={tUi("Max per minute (workspace {value0})", { value0: pacing.max_per_minute })} min={1} max={pacing.max_per_minute} value={config.pacing.max_per_minute} onChange={(value) => setConfig({ pacing: { ...config.pacing, max_per_minute: value } })} />
        <NumberField label={tUi("Batch size (workspace {value0})", { value0: globalMessaging.batch?.max_messages_per_batch ?? pacing.batch_size })} min={1} max={globalMessaging.batch?.max_messages_per_batch ?? 500} value={config.pacing.batch_size} onChange={(value) => setConfig({ pacing: { ...config.pacing, batch_size: value } })} />
        <NumberField label={tUi("Max in flight (workspace {value0})", { value0: globalMessaging.batch?.max_in_flight_per_campaign ?? pacing.max_in_flight })} min={1} max={globalMessaging.batch?.max_in_flight_per_campaign ?? 5000} value={config.pacing.max_in_flight} onChange={(value) => setConfig({ pacing: { ...config.pacing, max_in_flight: value } })} hint={tUi("Messages accepted by Telnyx without delivery evidence yet.")} />
        <NumberField label={tUi("Max attempts per contact")} min={1} max={globalMessaging.attempts?.max_attempts_per_contact ?? 100} value={draft?.retry_policy?.maxAttempts ?? null} onChange={(value) => update({ retry_policy: { ...(draft?.retry_policy || {}), maxAttempts: value == null ? undefined : Math.max(1, value) } })} hint={tUi("Only transient failures are retried; a delivered message ends the contact.")} />
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">{tUi("Effective now: ")}{pacing.max_per_minute}{tUi("/min · batches of ")}{pacing.batch_size}{tUi(" every ")}{pacing.batch_interval_seconds}{tUi("s · ")}{pacing.max_in_flight}{tUi(" in flight · ")}{pacing.max_per_hour}{tUi("/h · ")}{pacing.max_per_day}/day.</p>
    </PanelCard>

    {missingLabels.length ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300" data-testid="messaging-requirements"><IconSparkles className="mr-1 inline h-3.5 w-3.5" />{tUi("Required before saving: ")}{missingLabels.join(", ")}.</div> : null}
  </div>;
}
