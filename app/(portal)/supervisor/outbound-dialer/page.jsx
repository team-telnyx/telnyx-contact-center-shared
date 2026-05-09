"use client";

import React, { useMemo, useState } from "react";
import {
  IconAdjustmentsHorizontal,
  IconArrowRight,
  IconBellRinging,
  IconBrain,
  IconCalendarTime,
  IconChartBar,
  IconChecks,
  IconClockHour4,
  IconDatabase,
  IconDots,
  IconForms,
  IconListDetails,
  IconPhoneCall,
  IconPlayerPlay,
  IconReportAnalytics,
  IconRobot,
  IconSettings,
  IconShieldCheck,
  IconSparkles,
  IconUsers,
  IconWand,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconChartBar, description: "Live dialer performance" },
  { id: "campaigns", label: "Campaigns", icon: IconPhoneCall, description: "Build and tune outreach" },
  { id: "contact-lists", label: "Contact Lists", icon: IconDatabase, description: "Import audiences and fields" },
  { id: "dnc", label: "DNC", icon: IconShieldCheck, description: "Suppression governance" },
  { id: "attempt-controls", label: "Attempt Controls", icon: IconAdjustmentsHorizontal, description: "Caps, cadence, compliance" },
  { id: "reports", label: "Reports", icon: IconReportAnalytics, description: "Outcomes and exports" },
  { id: "event-viewer", label: "Event Viewer", icon: IconListDetails, description: "Dialer timeline" },
  { id: "settings", label: "Settings", icon: IconSettings, description: "Workspace defaults" },
];

const campaigns = [
  {
    id: "cmp-q2-winback",
    name: "Q2 Winback — Voice Preview",
    status: "Ready",
    channel: "Voice",
    mode: "Preview",
    handler: "Queue: Sales Closers",
    pacing: "1 contact / available agent",
    concurrency: 18,
    contactList: "Dormant pipeline accounts",
    form: "Winback qualification",
    progress: 68,
    connected: "31.4%",
    window: "Mon-Fri 09:00-18:00 Europe/Warsaw",
  },
  {
    id: "cmp-ai-renewal",
    name: "Renewal Reminder — Agentless AI",
    status: "Draft",
    channel: "Voice",
    mode: "Agentless AI",
    handler: "AI Assistant: Renewal Concierge",
    pacing: "Adaptive · max 42 concurrent",
    concurrency: 42,
    contactList: "Renewals next 45 days",
    form: "Not attached",
    progress: 24,
    connected: "—",
    window: "Customer timezone safe hours",
  },
  {
    id: "cmp-service-nps",
    name: "Service NPS Follow-up",
    status: "Paused",
    channel: "Voice",
    mode: "Progressive",
    handler: "Queue: Customer Success",
    pacing: "1.4 contacts / agent",
    concurrency: 12,
    contactList: "Post-ticket survey list",
    form: "NPS callback form",
    progress: 41,
    connected: "27.8%",
    window: "Mon-Sat 10:00-16:00 local",
  },
];

const contactLists = [
  {
    id: "list-dormant",
    name: "Dormant pipeline accounts",
    records: 12840,
    validPhones: "96.2%",
    customFields: 12,
    schema: ["account_tier", "renewal_date", "last_pipeline_stage", "owner_email"],
    status: "Validated",
  },
  {
    id: "list-renewals",
    name: "Renewals next 45 days",
    records: 4210,
    validPhones: "91.7%",
    customFields: 9,
    schema: ["contract_value", "renewal_date", "health_score", "preferred_language"],
    status: "Mapping needed",
  },
];

const fieldTypes = ["text", "boolean", "number", "date", "datetime", "enum", "select", "phone", "email", "url", "currency"];
const mappingRows = [
  { source: "first_name", type: "text", target: "customer.firstName", required: true },
  { source: "phone_number", type: "phone", target: "customer.phone", required: true },
  { source: "account_tier", type: "enum", target: "account.tier", required: false },
  { source: "renewal_date", type: "date", target: "renewal.date", required: false },
  { source: "contract_value", type: "currency", target: "opportunity.value", required: false },
];

const metricCards = [
  { label: "Ready campaigns", value: "7", delta: "+2 this week", icon: IconPlayerPlay, tone: "emerald" },
  { label: "Callable contacts", value: "48.9k", delta: "94.8% validated", icon: IconUsers, tone: "blue" },
  { label: "Connect rate", value: "29.6%", delta: "+4.1% vs baseline", icon: IconPhoneCall, tone: "violet" },
  { label: "Guardrail health", value: "98%", delta: "DNC + windows OK", icon: IconShieldCheck, tone: "amber" },
];

const toneClasses = {
  emerald: "from-emerald-500/18 to-teal-500/5 text-emerald-600 dark:text-emerald-300",
  blue: "from-sky-500/18 to-blue-500/5 text-sky-600 dark:text-sky-300",
  violet: "from-violet-500/18 to-fuchsia-500/5 text-violet-600 dark:text-violet-300",
  amber: "from-amber-500/20 to-orange-500/5 text-amber-600 dark:text-amber-300",
};

function statusClass(status) {
  if (status === "Ready" || status === "Validated") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "Draft" || status === "Mapping needed") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "Paused") return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
  return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
}

export default function OutboundDialerPage() {
  const [active, setActive] = useState("dashboard");
  const [selectedCampaign, setSelectedCampaign] = useState(campaigns[0]);
  const [selectedList, setSelectedList] = useState(contactLists[0]);
  const [previewCadence, setPreviewCadence] = useState(true);
  const activeMeta = useMemo(() => NAV_ITEMS.find((item) => item.id === active) || NAV_ITEMS[0], [active]);

  return (
    <div className="h-[calc(100vh-var(--header-height)-2rem)] min-h-0 -my-4 md:-my-6 overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.14),transparent_28%),radial-gradient(circle_at_85%_15%,rgba(168,85,247,0.14),transparent_26%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted))/0.55)]">
      <div className="flex h-full min-h-0 flex-col">
        <header className="shrink-0 border-b bg-background/80 px-5 py-4 backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                <IconSparkles className="h-4 w-4 text-sky-500" /> Supervisor workspace
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">Outbound Dialer</h1>
                <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">Phase 1 foundation</Badge>
                <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300">Voice first · omnichannel ready</Badge>
              </div>
              <p className="max-w-3xl text-sm text-muted-foreground">Campaign orchestration, contact list mapping, compliance controls, and Forms handoff scaffolding for future preview, progressive, and agentless dialing engines.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm"><IconBellRinging className="mr-2 h-4 w-4" />Event stream</Button>
              <Button size="sm" className="bg-gradient-to-r from-sky-600 to-violet-600 text-white hover:from-sky-500 hover:to-violet-500"><IconWand className="mr-2 h-4 w-4" />New campaign</Button>
            </div>
          </div>
        </header>

        <main className="grid flex-1 min-h-0 gap-3 p-3 xl:grid-cols-[250px_minmax(0,1fr)_360px] lg:grid-cols-[220px_minmax(0,1fr)_330px]">
          <aside className="min-h-0 overflow-hidden rounded-2xl border bg-card/92 shadow-sm backdrop-blur flex flex-col">
            <PanelHeader title="Dialer palette" description="Choose a workspace" />
            <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-1.5">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = active === item.id;
                return (
                  <button key={item.id} type="button" onClick={() => setActive(item.id)} className={`group w-full rounded-xl border px-3 py-3 text-left transition-all ${isActive ? "border-sky-500/40 bg-gradient-to-br from-sky-500/15 to-violet-500/10 shadow-sm" : "border-transparent hover:border-border hover:bg-muted/70"}`}>
                    <div className="flex items-start gap-3">
                      <span className={`rounded-lg p-2 transition ${isActive ? "bg-sky-500 text-white shadow-sm" : "bg-muted text-muted-foreground group-hover:bg-background group-hover:text-foreground"}`}><Icon className="h-4 w-4" /></span>
                      <span className="min-w-0"><span className="block text-sm font-semibold">{item.label}</span><span className="block text-xs text-muted-foreground">{item.description}</span></span>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="min-h-0 overflow-hidden rounded-2xl border bg-card/95 shadow-sm backdrop-blur flex flex-col">
            <div className="h-16 shrink-0 border-b px-5 flex items-center justify-between gap-3 bg-gradient-to-r from-background to-muted/50">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">{activeMeta.label}</h2>
                <p className="text-xs text-muted-foreground">{activeMeta.description}</p>
              </div>
              <div className="hidden items-center gap-2 md:flex"><Badge variant="outline">Safe-hours aware</Badge><Badge variant="outline">DNC enforced</Badge><Badge variant="outline">Forms-ready</Badge></div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5">
              {active === "dashboard" ? <DashboardView setActive={setActive} setSelectedCampaign={setSelectedCampaign} /> : null}
              {active === "campaigns" ? <CampaignsView selectedCampaign={selectedCampaign} setSelectedCampaign={setSelectedCampaign} /> : null}
              {active === "contact-lists" ? <ContactListsView selectedList={selectedList} setSelectedList={setSelectedList} /> : null}
              {! ["dashboard", "campaigns", "contact-lists"].includes(active) ? <ComingSoonView item={activeMeta} /> : null}
            </div>
          </section>

          <aside className="min-h-0 overflow-hidden rounded-2xl border bg-card/92 shadow-sm backdrop-blur flex flex-col">
            <PanelHeader title="Context settings" description={`${activeMeta.label} configuration`} />
            <SettingsPanel active={active} campaign={selectedCampaign} contactList={selectedList} previewCadence={previewCadence} setPreviewCadence={setPreviewCadence} />
          </aside>
        </main>
      </div>
    </div>
  );
}

function PanelHeader({ title, description }) {
  return <div className="h-16 shrink-0 border-b px-4 flex flex-col justify-center"><h2 className="text-sm font-semibold">{title}</h2><p className="text-xs text-muted-foreground">{description}</p></div>;
}

function DashboardView({ setActive, setSelectedCampaign }) {
  return <div className="space-y-5">
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {metricCards.map((metric) => {
        const Icon = metric.icon;
        return <div key={metric.label} className="rounded-2xl border bg-background/80 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className="flex items-center justify-between"><span className={`rounded-xl bg-gradient-to-br p-2.5 ${toneClasses[metric.tone]}`}><Icon className="h-5 w-5" /></span><IconDots className="h-4 w-4 text-muted-foreground" /></div><div className="mt-4 text-2xl font-semibold tracking-tight">{metric.value}</div><div className="text-sm text-muted-foreground">{metric.label}</div><div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-300">{metric.delta}</div></div>;
      })}
    </div>

    <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-2xl border bg-background/80 p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3"><div><h3 className="font-semibold">Campaign command center</h3><p className="text-sm text-muted-foreground">Voice campaigns staged for supervised rollout.</p></div><Button variant="outline" size="sm" onClick={() => setActive("campaigns")}>Open campaigns <IconArrowRight className="ml-2 h-4 w-4" /></Button></div>
        <div className="mt-4 space-y-3">
          {campaigns.map((campaign) => <button key={campaign.id} type="button" onClick={() => { setSelectedCampaign(campaign); setActive("campaigns"); }} className="w-full rounded-xl border bg-card p-4 text-left transition hover:border-sky-500/40 hover:bg-sky-500/5"><div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{campaign.name}</span><Badge variant="outline" className={statusClass(campaign.status)}>{campaign.status}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{campaign.mode} · {campaign.handler} · {campaign.window}</p></div><div className="text-right text-xs text-muted-foreground"><div className="font-semibold text-foreground">{campaign.progress}%</div>prepared</div></div><Progress className="mt-3 h-2" value={campaign.progress} /></button>)}
        </div>
      </div>
      <div className="rounded-2xl border bg-gradient-to-br from-slate-950 to-slate-900 p-5 text-white shadow-sm dark:from-slate-900 dark:to-slate-950">
        <div className="flex items-center gap-2 text-sky-200"><IconBrain className="h-5 w-5" /><span className="text-sm font-semibold">Dialer readiness assistant</span></div>
        <h3 className="mt-4 text-2xl font-semibold">3 launch blockers detected</h3>
        <p className="mt-2 text-sm text-slate-300">Renewal Reminder needs a contact-field to form-variable mapping, AMD confidence defaults, and safe-hours exception policy before it can be activated.</p>
        <div className="mt-5 space-y-2 text-sm">
          {['Map phone_number → customer.phone', 'Choose queue fallback for AI handoff', 'Confirm retry cap: 4 attempts / 7 days'].map((item) => <div key={item} className="flex items-center gap-2 rounded-xl bg-white/10 p-3"><IconChecks className="h-4 w-4 text-emerald-300" />{item}</div>)}
        </div>
      </div>
    </div>
  </div>;
}

function CampaignsView({ selectedCampaign, setSelectedCampaign }) {
  return <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
    <div className="space-y-3">
      {campaigns.map((campaign) => <button key={campaign.id} type="button" onClick={() => setSelectedCampaign(campaign)} className={`w-full rounded-2xl border p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${selectedCampaign.id === campaign.id ? "border-sky-500/50 bg-sky-500/10" : "bg-background/80 hover:border-border"}`}><div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{campaign.name}</h3><Badge variant="outline" className={statusClass(campaign.status)}>{campaign.status}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{campaign.contactList}</p></div><span className="rounded-xl bg-muted p-2"><IconPhoneCall className="h-4 w-4" /></span></div><div className="mt-4 grid grid-cols-3 gap-2 text-xs"><MiniStat label="Mode" value={campaign.mode} /><MiniStat label="Concurrency" value={campaign.concurrency} /><MiniStat label="Connect" value={campaign.connected} /></div></button>)}
    </div>
    <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">{selectedCampaign.name}</h3><p className="text-sm text-muted-foreground">Campaign configuration foundation — persisted model ready for worker orchestration.</p></div><Badge variant="outline" className={statusClass(selectedCampaign.status)}>{selectedCampaign.status}</Badge></div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <ConfigSelect label="Channel" value="Voice" options={["Voice", "SMS (future)", "WhatsApp (future)"]} />
        <ConfigSelect label="Mode" value={selectedCampaign.mode} options={["Preview", "Progressive", "Agentless AI", "Agentless Flow", "Power (future)", "Predictive (future)"]} />
        <ConfigSelect label="Handler" value={selectedCampaign.handler} options={["Queue: Sales Closers", "Queue: Customer Success", "AI Assistant: Renewal Concierge", "Call Flow: Qualification Bot"]} />
        <ConfigSelect label="Pacing strategy" value={selectedCampaign.pacing} options={["1 contact / available agent", "1.4 contacts / agent", "Adaptive · max 42 concurrent", "Manual supervisor approval"]} />
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-3"><InputBlock label="Max concurrency" value={String(selectedCampaign.concurrency)} /><InputBlock label="Dialing window" value="09:00-18:00" /><InputBlock label="Timezone policy" value="Contact local time" /></div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border bg-card p-4"><div className="flex items-center gap-2 font-semibold"><IconClockHour4 className="h-4 w-4 text-sky-500" />Retry policy</div><div className="mt-3 grid gap-3"><InputBlock label="Max attempts" value="4" /><InputBlock label="Min delay" value="6 hours" /><InputBlock label="Exhaust after" value="7 days" /></div></div>
        <div className="rounded-xl border bg-card p-4"><div className="flex items-center gap-2 font-semibold"><IconRobot className="h-4 w-4 text-violet-500" />AMD basics</div><div className="mt-3 space-y-3"><ToggleRow label="Detect answering machines" checked /><ToggleRow label="Leave flow-controlled voicemail" /><InputBlock label="Human confidence threshold" value="0.74" /></div></div>
      </div>
      <div className="mt-5 rounded-xl border bg-gradient-to-br from-sky-500/10 to-violet-500/10 p-4"><div className="flex items-center gap-2 font-semibold"><IconForms className="h-4 w-4 text-sky-600" />Forms integration</div><p className="mt-1 text-sm text-muted-foreground">Attach a Form for Preview/Progressive campaigns and map list fields into form variables before the agent sees the record.</p><div className="mt-4 grid gap-3 md:grid-cols-[0.9fr_1.1fr]"><ConfigSelect label="Attached form" value={selectedCampaign.form} options={["Winback qualification", "NPS callback form", "Renewal objection handler", "Not attached"]} /><ConfigSelect label="Mapping profile" value="Default contact + account mapping" options={["Default contact + account mapping", "Renewal value mapping", "Create new mapping profile"]} /></div><FieldMappingTable /></div>
    </div>
  </div>;
}

function ContactListsView({ selectedList, setSelectedList }) {
  return <div className="grid gap-4 xl:grid-cols-[0.82fr_1.18fr]">
    <div className="space-y-3">{contactLists.map((list) => <button key={list.id} type="button" onClick={() => setSelectedList(list)} className={`w-full rounded-2xl border p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${selectedList.id === list.id ? "border-violet-500/50 bg-violet-500/10" : "bg-background/80 hover:border-border"}`}><div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{list.name}</h3><Badge variant="outline" className={statusClass(list.status)}>{list.status}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{list.records.toLocaleString()} records · {list.validPhones} valid phones</p></div><IconDatabase className="h-5 w-5 text-violet-500" /></div><div className="mt-3 flex flex-wrap gap-1.5">{list.schema.map((field) => <Badge key={field} variant="secondary" className="font-mono text-[10px]">{field}</Badge>)}</div></button>)}</div>
    <div className="rounded-2xl border bg-background/85 p-5 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-semibold">{selectedList.name}</h3><p className="text-sm text-muted-foreground">Standard columns plus JSONB custom fields and typed schema metadata.</p></div><Button variant="outline" size="sm">Import CSV</Button></div><div className="mt-5 grid gap-3 md:grid-cols-3"><MiniStat label="Records" value={selectedList.records.toLocaleString()} /><MiniStat label="Valid phones" value={selectedList.validPhones} /><MiniStat label="Custom fields" value={selectedList.customFields} /></div><div className="mt-5 rounded-xl border bg-card p-4"><h4 className="font-semibold">Standard columns</h4><div className="mt-3 grid gap-2 md:grid-cols-2">{["first_name", "last_name", "phone_number", "email", "timezone", "country", "consent_status", "last_attempt_at"].map((field) => <SchemaRow key={field} name={field} type={field.includes("phone") ? "phone" : field.includes("email") ? "email" : field.includes("at") ? "datetime" : "text"} standard />)}</div></div><div className="mt-4 rounded-xl border bg-card p-4"><h4 className="font-semibold">Custom fields schema</h4><p className="mt-1 text-sm text-muted-foreground">Stored as custom_fields JSONB with a schema registry for validation, segmentation, and Forms variable mapping.</p><div className="mt-3 grid gap-2 md:grid-cols-2">{fieldTypes.map((type) => <SchemaRow key={type} name={`custom_${type}`} type={type} />)}</div></div></div>
  </div>;
}

function SettingsPanel({ active, campaign, contactList, previewCadence, setPreviewCadence }) {
  if (active === "campaigns") return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconPhoneCall} title="Selected campaign" subtitle={campaign.name}><div className="space-y-3"><ConfigSelect label="Launch state" value={campaign.status} options={["Draft", "Ready", "Paused"]} /><ToggleRow label="Require supervisor approval" checked /><ToggleRow label="Enable live pacing guardrails" checked={previewCadence} onCheckedChange={setPreviewCadence} /></div></SettingCard><SettingCard icon={IconCalendarTime} title="Compliance window" subtitle="Applied before each attempt"><Textarea defaultValue={campaign.window} rows={3} /></SettingCard><SettingCard icon={IconForms} title="Form variable quality" subtitle="Human campaign readiness"><div className="space-y-2 text-sm"><ReadinessLine label="Required contact fields" ok /><ReadinessLine label="Custom variables mapped" ok={campaign.status !== "Draft"} /><ReadinessLine label="Preview form attached" ok={campaign.form !== "Not attached"} /></div></SettingCard></div>;
  if (active === "contact-lists") return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconDatabase} title="List hygiene" subtitle={contactList.name}><ToggleRow label="Normalize E.164 phones" checked /><ToggleRow label="Respect DNC at import" checked /><ToggleRow label="Infer custom field types" checked /></SettingCard><SettingCard icon={IconForms} title="Default mapping" subtitle="Contact list → Form variables"><FieldMappingTable compact /></SettingCard></div>;
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconSparkles} title="Workspace defaults" subtitle="Phase 1 configuration surface"><ConfigSelect label="Default channel" value="Voice" options={["Voice", "SMS (future)", "WhatsApp (future)"]} /><ConfigSelect label="Default mode" value="Preview" options={["Preview", "Progressive", "Agentless AI", "Agentless Flow"]} /><ToggleRow label="Show launch readiness checks" checked /><ToggleRow label="Emit worker events to Event Viewer" checked /></SettingCard><div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Settings are UI/model scaffolding only. The outbound worker, actual dialing execution, and campaign activation flow intentionally remain future phases.</div></div>;
}

function ComingSoonView({ item }) { const Icon = item.icon; return <div className="flex min-h-[520px] items-center justify-center"><div className="max-w-md rounded-3xl border bg-background/85 p-8 text-center shadow-sm"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 to-violet-500/20 text-sky-600"><Icon className="h-7 w-7" /></div><h3 className="mt-5 text-xl font-semibold">{item.label} is staged for Phase 2</h3><p className="mt-2 text-sm text-muted-foreground">The navigation, settings surface, and visual language are in place. Future work can connect this area to dialer execution, audit events, and reporting data.</p><Button className="mt-5" variant="outline">View roadmap</Button></div></div>; }
function MiniStat({ label, value }) { return <div className="rounded-lg border bg-muted/40 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 truncate text-sm font-semibold">{value}</div></div>; }
function ConfigSelect({ label, value, options }) { return <div className="space-y-2"><Label>{label}</Label><Select value={value} onValueChange={() => {}}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div>; }
function InputBlock({ label, value }) { return <div className="space-y-2"><Label>{label}</Label><Input defaultValue={value} /></div>; }
function ToggleRow({ label, checked = false, onCheckedChange }) { return <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 p-3"><Label className="text-sm font-medium">{label}</Label><Switch checked={checked} onCheckedChange={onCheckedChange || (() => {})} /></div>; }
function FieldMappingTable({ compact = false }) { return <div className={`mt-4 overflow-hidden rounded-xl border ${compact ? "text-xs" : "text-sm"}`}><div className="grid grid-cols-[1fr_0.7fr_1fr_70px] bg-muted/60 px-3 py-2 text-xs font-semibold text-muted-foreground"><span>Contact field</span><span>Type</span><span>Form variable</span><span>Req.</span></div>{mappingRows.map((row) => <div key={row.source} className="grid grid-cols-[1fr_0.7fr_1fr_70px] items-center border-t px-3 py-2"><span className="font-mono text-xs">{row.source}</span><Badge variant="secondary" className="w-fit font-mono text-[10px]">{row.type}</Badge><span className="font-mono text-xs text-sky-700 dark:text-sky-300">{row.target}</span><span>{row.required ? <IconChecks className="h-4 w-4 text-emerald-500" /> : "—"}</span></div>)}</div>; }
function SchemaRow({ name, type, standard = false }) { return <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 px-3 py-2"><div className="min-w-0"><div className="truncate font-mono text-xs">{name}</div><div className="text-[11px] text-muted-foreground">{standard ? "standard column" : "custom_fields JSONB"}</div></div><Badge variant="outline" className="font-mono text-[10px]">{type}</Badge></div>; }
function SettingCard({ icon: Icon, title, subtitle, children }) { return <div className="rounded-2xl border bg-background/85 p-4 shadow-sm"><div className="mb-4 flex items-start gap-3"><span className="rounded-xl bg-gradient-to-br from-sky-500/15 to-violet-500/15 p-2 text-sky-600"><Icon className="h-4 w-4" /></span><div><h3 className="text-sm font-semibold">{title}</h3><p className="text-xs text-muted-foreground">{subtitle}</p></div></div>{children}</div>; }
function ReadinessLine({ label, ok }) { return <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2"><span>{label}</span><Badge variant="outline" className={ok ? statusClass("Ready") : statusClass("Draft")}>{ok ? "Ready" : "Needs setup"}</Badge></div>; }
