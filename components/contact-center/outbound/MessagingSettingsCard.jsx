"use client";
import { IconBrandWhatsapp, IconMail, IconMessage, IconSettings2 } from "@tabler/icons-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import DraftTextInput from "./DraftTextInput";
import SettingsFieldInfo from "./SettingsFieldInfo";
import { MESSAGING_SETTINGS_LIMITS, normalizeMessagingSettings } from "@/lib/outbound-dialer/messaging/settings.mjs";

// Every channel here has a campaign template source, a sender model and a
// provider command, so all three can be enabled. Keep this in step with
// `messagingChannelsAvailable` in lib/outbound-dialer/api.js.
const CHANNELS = [
  { id: "sms", label: "SMS", icon: IconMessage },
  { id: "whatsapp", label: "WhatsApp", icon: IconBrandWhatsapp },
  { id: "email", label: "Email", icon: IconMail },
];

// Sections of Dialer → Settings → Messaging campaigns. The dialer page shows one
// selectable card per section and edits the selected section on the right.
export const MESSAGING_SETTINGS_SECTIONS = [
  { id: "shared", label: "Shared", description: "Enabled channels, batches, retries, safety breakers, windows and replies", icon: IconSettings2 },
  { id: "sms", label: "SMS", description: "Rate limits, opt-out footer, segment cap and allowed sender numbers", icon: IconMessage },
  { id: "whatsapp", label: "WhatsApp", description: "Rate limits, recipient caps, consent and template pausing", icon: IconBrandWhatsapp },
  { id: "email", label: "Email", description: "Rate limits, batch size, unsubscribe and suppression rules", icon: IconMail },
];

const yesNo = (value) => (value ? "On" : "Off");

// Compact key/value summary for the section cards on the dialer settings page.
export function messagingSettingsSummary(section, value) {
  const settings = normalizeMessagingSettings(value || {});
  if (section === "shared") {
    const enabled = CHANNELS.filter((channel) => settings.enabled_channels[channel.id]).map((channel) => channel.label);
    return [
      { label: "Enabled channels", value: enabled.length ? enabled.join(", ") : "None" },
      { label: "Batch", value: `${settings.batch.max_messages_per_batch} every ${settings.batch.batch_interval_seconds}s · ${settings.batch.max_in_flight_per_campaign} in flight` },
      { label: "Attempts", value: `${settings.attempts.max_attempts_per_contact} per contact · retry ${settings.attempts.transient_retry_minutes} min` },
      { label: "Auto-pause", value: `${settings.safety.auto_pause_failure_rate_percent}% failures in ${settings.safety.failure_rate_window_minutes} min` },
      { label: "Test mode", value: settings.safety.test_mode.enabled ? `On · ${settings.safety.test_mode.allowlist.length} allowed` : "Off" },
      { label: "Reply attribution", value: `${settings.reply.attribution_hours} h` },
    ];
  }
  if (section === "sms") {
    return [
      { label: "Rate", value: `${settings.rate.sms.max_per_minute}/min · ${settings.rate.sms.max_per_hour}/h · ${settings.rate.sms.max_per_day}/day` },
      { label: "Per number", value: `${settings.rate.sms.per_sender_per_minute}/min · ${settings.rate.sms.per_sender_daily}/day` },
      { label: "Opt-out footer", value: settings.sms.require_opt_out_footer ? `Required · “${settings.sms.opt_out_footer_text}”` : "Optional" },
      { label: "Max parts", value: String(settings.sms.max_segments_per_message) },
      { label: "STOP across numbers", value: yesNo(settings.sms.honor_opt_out_across_numbers) },
      { label: "Allowed senders", value: settings.senders.sms_numbers.length ? `${settings.senders.sms_numbers.length} selected` : "All sending-enabled numbers" },
    ];
  }
  if (section === "whatsapp") {
    return [
      { label: "Rate", value: `${settings.rate.whatsapp.max_per_minute}/min · ${settings.rate.whatsapp.max_per_hour}/h · ${settings.rate.whatsapp.max_per_day}/day` },
      { label: "Unique recipients / 24 h", value: String(settings.rate.whatsapp.unique_recipients_24h) },
      { label: "Same recipient interval", value: `${settings.rate.whatsapp.same_recipient_min_interval_seconds}s` },
      { label: "Template categories", value: settings.whatsapp.allowed_template_categories.join(", ") },
      { label: "Consent for marketing", value: yesNo(settings.whatsapp.require_consent_for_marketing) },
      { label: "Pause on template pause", value: yesNo(settings.whatsapp.auto_pause_on_template_pause) },
    ];
  }
  return [
    { label: "Rate", value: `${settings.rate.email.max_per_minute}/min · ${settings.rate.email.max_per_hour}/h · ${settings.rate.email.max_per_day}/day` },
    { label: "Batch API size", value: String(settings.rate.email.batch_api_size) },
    { label: "Unsubscribe link", value: settings.email.require_unsubscribe ? "Required" : "Optional" },
    { label: "Suppress bounces / complaints", value: `${yesNo(settings.email.suppress_on_bounce)} / ${yesNo(settings.email.suppress_on_complaint)}` },
    { label: "Tracking", value: settings.email.tracking.opens || settings.email.tracking.clicks ? [settings.email.tracking.opens ? "opens" : null, settings.email.tracking.clicks ? "clicks" : null].filter(Boolean).join(", ") : "Off" },
    { label: "Default reply-to", value: settings.email.default_reply_to || "—" },
  ];
}

// Single-line label plus an info icon: inputs in a two-column row keep the same
// baseline and the explanation shows on hover instead of pushing fields apart.
function FieldLabel({ label, hint }) {
  return <div className="flex h-5 min-w-0 items-center gap-1"><Label className="min-w-0 truncate text-sm" title={label}>{label}</Label><SettingsFieldInfo hint={hint} label={label} /></div>;
}
function Num({ label, value, onChange, limitKey, hint }) {
  const [min, max] = MESSAGING_SETTINGS_LIMITS[limitKey] || [0, Number.MAX_SAFE_INTEGER];
  // The normalizer clamps, so a field cleared to type a new number would jump
  // straight back to its minimum. The field keeps what is being typed and the
  // clamped value is adopted on blur.
  return <div className="min-w-0 space-y-2"><FieldLabel label={label} hint={hint} /><DraftTextInput type="number" min={min} max={max} value={value ?? ""} parse={(raw) => (raw.trim() === "" ? min : Number(raw))} onChange={onChange} /></div>;
}
function Text({ label, value, onChange, hint, placeholder, maxLength }) {
  // DraftTextInput, not Input: this card re-normalizes its value on every
  // render and the normalizer trims, which would swallow every space typed.
  return <div className="min-w-0 space-y-2"><FieldLabel label={label} hint={hint} /><DraftTextInput value={value ?? ""} maxLength={maxLength} placeholder={placeholder} onChange={onChange} /></div>;
}
function Toggle({ label, checked, onCheckedChange, hint }) {
  return <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 p-3"><div className="flex min-w-0 items-center gap-1"><Label className="min-w-0 truncate text-sm font-medium" title={label}>{label}</Label><SettingsFieldInfo hint={hint} label={label} /></div><Switch checked={Boolean(checked)} onCheckedChange={onCheckedChange} /></div>;
}
function Section({ title, children }) { return <div className="space-y-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>{children}</div>; }

// One section of Dialer → Settings → Messaging campaigns. Campaigns may only
// tighten these workspace-wide values.
export default function MessagingSettingsCard({ section = "shared", value, onChange, senders = {} }) {
  const settings = normalizeMessagingSettings(value || {});
  const meta = MESSAGING_SETTINGS_SECTIONS.find((item) => item.id === section) || MESSAGING_SETTINGS_SECTIONS[0];
  const Icon = meta.icon;
  const patch = (path, patchValue) => {
    const next = structuredClone(settings);
    let cursor = next;
    for (const key of path.slice(0, -1)) cursor = cursor[key];
    cursor[path[path.length - 1]] = patchValue;
    onChange(next);
  };
  const smsSenders = senders?.sms || [];
  return <div className="rounded-2xl border bg-background/85 p-4 shadow-sm" data-testid="messaging-settings-card" data-section={meta.id}>
    <div className="mb-4 flex items-start gap-3"><span className="rounded-xl bg-gradient-to-br from-sky-500/15 to-violet-500/15 p-2 text-sky-600"><Icon className="h-4 w-4" /></span><div className="min-w-0"><h3 className="text-sm font-semibold">Messaging campaigns · {meta.label}</h3><p className="text-xs text-muted-foreground">{meta.description}. Campaigns can only use equal or stricter values.</p></div></div>
    {meta.id === "shared" ? <div className="space-y-5">
      <Section title="Enabled channels">
        <div className="grid gap-2">{CHANNELS.map((channel) => { const ChannelIcon = channel.icon; return <label key={channel.id} className="flex items-center gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm"><Checkbox checked={settings.enabled_channels[channel.id]} onCheckedChange={(checked) => patch(["enabled_channels", channel.id], checked === true)} /><ChannelIcon className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{channel.label}</span></label>; })}</div>
        <p className="text-[11px] text-muted-foreground">A disabled channel blocks Start and pauses running campaigns on the next tick.</p>
      </Section>
      <Section title="Batches">
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <Num label="Batch size" limitKey="max_messages_per_batch" value={settings.batch.max_messages_per_batch} onChange={(v) => patch(["batch", "max_messages_per_batch"], v)} hint="Messages one campaign hands to Telnyx in a single tick." />
          <Num label="Batch interval (s)" limitKey="batch_interval_seconds" value={settings.batch.batch_interval_seconds} onChange={(v) => patch(["batch", "batch_interval_seconds"], v)} hint="Pause between two batches of the same campaign." />
          <Num label="Max in flight" limitKey="max_in_flight_per_campaign" value={settings.batch.max_in_flight_per_campaign} onChange={(v) => patch(["batch", "max_in_flight_per_campaign"], v)} hint="Messages accepted by Telnyx that are still waiting for delivery evidence." />
        </div>
      </Section>
      <Section title="Attempts and retries">
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <Num label="Max attempts" limitKey="max_attempts_per_contact" value={settings.attempts.max_attempts_per_contact} onChange={(v) => patch(["attempts", "max_attempts_per_contact"], v)} hint="Attempts per contact. A delivered message always ends the contact." />
          <Num label="Transient retry (min)" limitKey="transient_retry_minutes" value={settings.attempts.transient_retry_minutes} onChange={(v) => patch(["attempts", "transient_retry_minutes"], v)} hint="Delay before retrying a carrier failure that may pass, such as a daily 10DLC limit." />
          <Num label="Throttled retry (min)" limitKey="throttled_retry_minutes" value={settings.attempts.throttled_retry_minutes} onChange={(v) => patch(["attempts", "throttled_retry_minutes"], v)} hint="Delay before retrying a message the provider rate-limited." />
          <Num label="Frequency cap (h)" limitKey="frequency_cap_retry_hours" value={settings.attempts.frequency_cap_retry_hours} onChange={(v) => patch(["attempts", "frequency_cap_retry_hours"], v)} hint="Wait after WhatsApp rejects a marketing template for the per-user cap (error 131049). Meta asks for at least 24 hours." />
        </div>
      </Section>
      <Section title="Safety">
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <Num label="Auto-pause at (%)" limitKey="auto_pause_failure_rate_percent" value={settings.safety.auto_pause_failure_rate_percent} onChange={(v) => patch(["safety", "auto_pause_failure_rate_percent"], v)} hint="Failure share in the window that pauses a campaign automatically." />
          <Num label="Failure window (min)" limitKey="failure_rate_window_minutes" value={settings.safety.failure_rate_window_minutes} onChange={(v) => patch(["safety", "failure_rate_window_minutes"], v)} hint="Rolling window the failure share is measured over." />
          <Num label="Minimum sample" limitKey="failure_rate_min_sample" value={settings.safety.failure_rate_min_sample} onChange={(v) => patch(["safety", "failure_rate_min_sample"], v)} hint="Messages needed in the window before the breaker can fire." />
          <Num label="Pause after 429 (s)" limitKey="on_429_pause_seconds" value={settings.safety.on_429_pause_seconds} onChange={(v) => patch(["safety", "on_429_pause_seconds"], v)} hint="How long a campaign waits after the provider rate-limits a send." />
          <Num label="Campaign cap" limitKey="max_messages_per_campaign" value={settings.safety.max_messages_per_campaign} onChange={(v) => patch(["safety", "max_messages_per_campaign"], v)} hint="Hard ceiling of messages one campaign may ever send. 0 means no cap." />
        </div>
        <Toggle label="Test mode" hint="Only allowlisted phone numbers and email addresses receive campaign messages. Everything else is suppressed." checked={settings.safety.test_mode.enabled} onCheckedChange={(checked) => patch(["safety", "test_mode", "enabled"], checked === true)} />
        <div className="min-w-0 space-y-2"><FieldLabel label="Test allowlist" hint="One phone number or email address per line." /><Textarea rows={2} value={settings.safety.test_mode.allowlist.join("\n")} placeholder={"+48600000001\nname@example.com"} onChange={(e) => patch(["safety", "test_mode", "allowlist"], e.target.value.split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean))} /></div>
      </Section>
      <Section title="Windows and replies">
        <Toggle label="Use callable defaults" hint="Campaigns without their own Time Set follow the callable days and window from Time Zone Settings. SMS and WhatsApp only." checked={settings.windows.use_callable_defaults} onCheckedChange={(checked) => patch(["windows", "use_callable_defaults"], checked === true)} />
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <Num label="Attribution window (h)" limitKey="attribution_hours" value={settings.reply.attribution_hours} onChange={(v) => patch(["reply", "attribution_hours"], v)} hint="A customer reply within this window marks the campaign message as replied." />
          <Num label="Pause on backlog" limitKey="pause_when_reply_queue_waiting_over" value={settings.reply.pause_when_reply_queue_waiting_over} onChange={(v) => patch(["reply", "pause_when_reply_queue_waiting_over"], v)} hint="Stop sending while more than this many replies wait in the queue. 0 disables the check." />
        </div>
      </Section>
    </div> : null}
    {meta.id === "sms" ? <div className="space-y-5">
      <Section title="Rate limits">
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <Num label="Max per minute" limitKey="max_per_minute" value={settings.rate.sms.max_per_minute} onChange={(v) => patch(["rate", "sms", "max_per_minute"], v)} hint="Across every SMS campaign. The Telnyx account default is 50 messages per second." />
          <Num label="Max per hour" limitKey="max_per_hour" value={settings.rate.sms.max_per_hour} onChange={(v) => patch(["rate", "sms", "max_per_hour"], v)} hint="Rolling hourly ceiling across every SMS campaign." />
          <Num label="Max per day" limitKey="max_per_day" value={settings.rate.sms.max_per_day} onChange={(v) => patch(["rate", "sms", "max_per_day"], v)} hint="Rolling daily ceiling across every SMS campaign." />
          <Num label="Per number / min" limitKey="per_sender_per_minute" value={settings.rate.sms.per_sender_per_minute} onChange={(v) => patch(["rate", "sms", "per_sender_per_minute"], v)} hint="Long codes outside the US are limited to 0.1 messages per second, about 6 per minute. US traffic follows the throughput of the registered 10DLC campaign." />
          <Num label="Per number / day" limitKey="per_sender_daily" value={settings.rate.sms.per_sender_daily} onChange={(v) => patch(["rate", "sms", "per_sender_daily"], v)} hint="T-Mobile applies daily brand caps that start at 2,000 messages." />
        </div>
      </Section>
      <Section title="Compliance">
        <Toggle label="Require opt-out footer" hint="The footer is appended to every campaign message unless the template already contains it." checked={settings.sms.require_opt_out_footer} onCheckedChange={(checked) => patch(["sms", "require_opt_out_footer"], checked === true)} />
        <Text label="Footer text" value={settings.sms.opt_out_footer_text} maxLength={120} onChange={(v) => patch(["sms", "opt_out_footer_text"], v)} hint="Counted towards the message length, so it can add a segment." />
        <div className="grid gap-3 @[480px]:grid-cols-2"><Num label="Max parts" limitKey="max_segments_per_message" value={settings.sms.max_segments_per_message} onChange={(v) => patch(["sms", "max_segments_per_message"], v)} hint="Cost control for long messages. The carrier hard limit is 10 parts." /></div>
        <Toggle label="STOP across numbers" hint="A customer who texted STOP to any Contact Center number is skipped by every campaign, not only by the number they replied to." checked={settings.sms.honor_opt_out_across_numbers} onCheckedChange={(checked) => patch(["sms", "honor_opt_out_across_numbers"], checked === true)} />
      </Section>
      <Section title="Allowed sender numbers">
        {smsSenders.length ? <div className="grid gap-2">{smsSenders.map((sender) => <label key={sender.id} className="flex items-center gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm"><Checkbox checked={settings.senders.sms_numbers.includes(sender.id)} onCheckedChange={(checked) => patch(["senders", "sms_numbers"], checked === true ? [...settings.senders.sms_numbers, sender.id] : settings.senders.sms_numbers.filter((id) => id !== sender.id))} /><span className="min-w-0"><span className="block truncate">{sender.phone_number}</span><span className="block truncate text-[11px] text-muted-foreground">{sender.name}{sender.queue_name ? ` → ${sender.queue_name}` : ""}{!sender.sending_enabled ? " · sending paused" : ""}</span></span></label>)}</div> : <p className="text-xs text-muted-foreground">Map SMS numbers under Admin → SMS → Numbers first.</p>}
        <p className="text-[11px] text-muted-foreground">Leave empty to allow every sending-enabled number.</p>
      </Section>
    </div> : null}
    {meta.id === "whatsapp" ? <div className="space-y-5">
      <Section title="Rate limits">
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <Num label="Max per minute" limitKey="max_per_minute" value={settings.rate.whatsapp.max_per_minute} onChange={(v) => patch(["rate", "whatsapp", "max_per_minute"], v)} hint="Meta allows 80 messages per second per business number by default." />
          <Num label="Max per hour" limitKey="max_per_hour" value={settings.rate.whatsapp.max_per_hour} onChange={(v) => patch(["rate", "whatsapp", "max_per_hour"], v)} hint="Rolling hourly ceiling across every WhatsApp campaign." />
          <Num label="Max per day" limitKey="max_per_day" value={settings.rate.whatsapp.max_per_day} onChange={(v) => patch(["rate", "whatsapp", "max_per_day"], v)} hint="Rolling daily ceiling across every WhatsApp campaign." />
          <Num label="Unique / 24 h" limitKey="unique_recipients_24h" value={settings.rate.whatsapp.unique_recipients_24h} onChange={(v) => patch(["rate", "whatsapp", "unique_recipients_24h"], v)} hint="Meta messaging tiers: 250, 2,000, 10,000, 100,000 unique recipients in a rolling 24 hours, counted per business portfolio." />
          <Num label="Pair interval (s)" limitKey="same_recipient_min_interval_seconds" value={settings.rate.whatsapp.same_recipient_min_interval_seconds} onChange={(v) => patch(["rate", "whatsapp", "same_recipient_min_interval_seconds"], v)} hint="Meta pair rate limit: one message every six seconds to the same WhatsApp user." />
        </div>
      </Section>
      <Section title="Compliance">
        <Toggle label="Consent for marketing" hint="Marketing templates are only sent to contacts whose consent field holds an accepted value." checked={settings.whatsapp.require_consent_for_marketing} onCheckedChange={(checked) => patch(["whatsapp", "require_consent_for_marketing"], checked === true)} />
        <Toggle label="Pause on template pause" hint="Meta pauses templates with poor quality for 3 hours, then 6 hours, then disables them. Campaigns using such a template pause too." checked={settings.whatsapp.auto_pause_on_template_pause} onCheckedChange={(checked) => patch(["whatsapp", "auto_pause_on_template_pause"], checked === true)} />
      </Section>
    </div> : null}
    {meta.id === "email" ? <div className="space-y-5">
      <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">Email campaigns arrive in a later phase. Limits below are stored now.</p>
      <Section title="Rate limits">
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <Num label="Max per minute" limitKey="max_per_minute" value={settings.rate.email.max_per_minute} onChange={(v) => patch(["rate", "email", "max_per_minute"], v)} hint="Across every email campaign." />
          <Num label="Max per hour" limitKey="max_per_hour" value={settings.rate.email.max_per_hour} onChange={(v) => patch(["rate", "email", "max_per_hour"], v)} hint="Gmail and Outlook accept about 500 messages per hour per sending domain before they throttle." />
          <Num label="Max per day" limitKey="max_per_day" value={settings.rate.email.max_per_day} onChange={(v) => patch(["rate", "email", "max_per_day"], v)} hint="The Telnyx daily quota is counted in recipients and resets at midnight UTC." />
          <Num label="Batch API size" limitKey="batch_api_size" value={settings.rate.email.batch_api_size} onChange={(v) => patch(["rate", "email", "batch_api_size"], v)} hint="Messages per batch request. The Telnyx hard limit is 1,000." />
        </div>
      </Section>
      <Section title="Compliance">
        <Toggle label="Require unsubscribe" hint="Campaigns must map an unsubscribe link before they can start." checked={settings.email.require_unsubscribe} onCheckedChange={(checked) => patch(["email", "require_unsubscribe"], checked === true)} />
        <Text label="Unsubscribe group" value={settings.email.unsubscribe_group_id} maxLength={120} placeholder="Telnyx unsubscribe group id" onChange={(v) => patch(["email", "unsubscribe_group_id"], v)} hint="Telnyx unsubscribe group applied to campaign messages." />
        <Toggle label="List-Unsubscribe header" hint="Required by Gmail and Yahoo for bulk senders (RFC 8058 one-click unsubscribe)." checked={settings.email.add_list_unsubscribe_header} onCheckedChange={(checked) => patch(["email", "add_list_unsubscribe_header"], checked === true)} />
        <Toggle label="Suppress bounces" hint="A hard bounce suppresses the address for later campaigns." checked={settings.email.suppress_on_bounce} onCheckedChange={(checked) => patch(["email", "suppress_on_bounce"], checked === true)} />
        <Toggle label="Suppress complaints" hint="A spam complaint suppresses the address for later campaigns." checked={settings.email.suppress_on_complaint} onCheckedChange={(checked) => patch(["email", "suppress_on_complaint"], checked === true)} />
        <div className="grid gap-3 @[480px]:grid-cols-2"><Num label="Suppression sync (min)" limitKey="suppression_sync_minutes" value={settings.email.suppression_sync_minutes} onChange={(v) => patch(["email", "suppression_sync_minutes"], v)} hint="How often the local suppression mirror is refreshed from the Telnyx block list." /></div>
        <Toggle label="Track opens" hint="Adds an open-tracking pixel. Off by default for privacy." checked={settings.email.tracking.opens} onCheckedChange={(checked) => patch(["email", "tracking", "opens"], checked === true)} />
        <Toggle label="Track clicks" hint="Rewrites links for click tracking. Off by default for privacy." checked={settings.email.tracking.clicks} onCheckedChange={(checked) => patch(["email", "tracking", "clicks"], checked === true)} />
      </Section>
      <Section title="Defaults">
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <Text label="From name" value={settings.email.default_from_name} maxLength={120} onChange={(v) => patch(["email", "default_from_name"], v)} hint="Display name new campaigns start with." />
          <Text label="Reply-to" value={settings.email.default_reply_to} maxLength={254} placeholder="support@example.com" onChange={(v) => patch(["email", "default_reply_to"], v)} hint="Address customer replies are sent to. It must belong to a mailbox that routes to a queue." />
        </div>
      </Section>
    </div> : null}
  </div>;
}
