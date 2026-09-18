"use client";

import { useMemo, useState } from "react";
import {
  Braces, CheckCircle2, ChevronDown, CircleDot, Copy, Eye, EyeOff, GitBranch,
  Languages, ListFilter, Play, Plus, Route, Sparkles, Trash2, UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  BUILT_IN_DECISION_VARIABLES, DECISION_ACTION_TYPES, DECISION_OPERATORS,
} from "@/lib/widgets/decisions";
import { WIDGET_LOCALES } from "@/lib/widgets/locales";

function uid(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function SelectBox({ value, onChange, children, placeholder = "Select…" }) {
  return (
    <Select value={String(value ?? "")} onValueChange={onChange}>
      <SelectTrigger className="h-9 min-w-0 max-w-full bg-background"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

function Labeled({ label, hint, children }) {
  return <label className="grid min-w-0 max-w-full gap-1.5"><span className="text-xs font-medium">{label}</span>{children}{hint && <span className="break-words text-[11px] leading-relaxed text-muted-foreground">{hint}</span>}</label>;
}

function ResultBadge({ result }) {
  if (!result.enabled) return <Badge variant="outline">Engine off</Badge>;
  if (!result.matched) return <Badge variant="secondary">Default behavior</Badge>;
  if (!result.visible) return <Badge className="border-red-200 bg-red-50 text-red-700 hover:bg-red-50">Widget hidden</Badge>;
  return <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50">Rule matched</Badge>;
}

function ActionIcon({ type }) {
  const icons = { visibility: Eye, channels: ListFilter, locale: Languages, surface: CircleDot, "route-queue": Route, "customer-label": UserRound };
  const Icon = icons[type] || Sparkles;
  return <Icon className="size-4" />;
}

function DecisionRuleCard({ rule, trace, active = false, expanded = false }) {
  return (
    <span className={`block min-w-0 max-w-full overflow-hidden rounded-xl border p-3 text-left transition-all ${active ? "border-primary bg-primary/5 shadow-sm" : "bg-background hover:bg-muted/40"}`}>
      <span className="flex min-w-0 items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${trace?.matched ? "bg-emerald-500" : rule.enabled ? "bg-muted-foreground/40" : "bg-muted"}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{rule.name}</span>
        <Badge variant="outline" className="shrink-0 text-[10px]">P{rule.priority}</Badge>
        <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
      </span>
      <span className="mt-1.5 block truncate pl-4 text-[11px] text-muted-foreground">
        {rule.match === "all" ? "All" : "Any"} of {rule.conditions.length} · {rule.actions.length} action{rule.actions.length === 1 ? "" : "s"}
      </span>
    </span>
  );
}

function actionValueEditor(action, config, update) {
  if (action.type === "visibility") return <SelectBox value={action.value} onChange={(value) => update({ value })}><SelectItem value="visible">Show widget</SelectItem><SelectItem value="hidden">Hide widget</SelectItem></SelectBox>;
  if (action.type === "channels") return <SelectBox value={action.value} onChange={(value) => update({ value })}><SelectItem value="both">Messaging and voice</SelectItem><SelectItem value="messaging">Messaging only</SelectItem><SelectItem value="voice">Voice only</SelectItem></SelectBox>;
  if (action.type === "locale") return <SelectBox value={action.value} onChange={(value) => update({ value })}>{WIDGET_LOCALES.map((locale) => <SelectItem key={locale.id} value={locale.id}>{locale.flag} {locale.language} · {locale.country}</SelectItem>)}</SelectBox>;
  if (action.type === "surface") return <SelectBox value={action.value} onChange={(value) => update({ value })}><SelectItem value="launcher">Launcher / FAB</SelectItem><SelectItem value="home">Home</SelectItem><SelectItem value="chat">Chat</SelectItem><SelectItem value="voice">Voice</SelectItem></SelectBox>;
  if (action.type === "route-queue") {
    const queues = config.channels.messaging.routing.queues || [];
    const dynamicValue = String(action.value || "").includes("{{") ? String(action.value) : "";
    return <SelectBox value={action.value} onChange={(value) => { const queue = queues.find((item) => item.id === value); update({ value, valueLabel: queue?.name || (value === dynamicValue ? "Queue from context" : value) }); }}>{dynamicValue && <SelectItem value={dynamicValue}>Context variable · {dynamicValue}</SelectItem>}{queues.map((queue) => <SelectItem key={queue.id} value={queue.id}>{queue.name}</SelectItem>)}</SelectBox>;
  }
  if (action.type === "launcher-delay" || action.type === "auto-open") return <div className="relative"><Input className="h-9 pr-12" type="number" min="0" max="3600" value={action.value} onChange={(event) => update({ value: Number(event.target.value) || 0 })} /><span className="pointer-events-none absolute right-3 top-2.5 text-xs text-muted-foreground">sec</span></div>;
  return <Input className="h-9" value={String(action.value ?? "")} onChange={(event) => update({ value: event.target.value })} placeholder="e.g. {{customer.firstName}}" />;
}

function initialActionValue(type, config) {
  if (type === "visibility") return "visible";
  if (type === "channels") return "both";
  if (type === "locale") return config.locale;
  if (type === "surface") return "home";
  if (type === "launcher-delay" || type === "auto-open") return 0;
  if (type === "route-queue") return config.channels.messaging.routing.queues?.[0]?.id || "";
  if (type === "customer-label") return "{{customer.firstName}}";
  return "";
}

export default function RulesDecisionBuilder({ config, set, result, onRunSimulation }) {
  const rules = config.decisions.rules;
  const [selectedRuleId, setSelectedRuleId] = useState(rules[0]?.id || "");
  const [rulesOpen, setRulesOpen] = useState(false);
  const activeRuleId = rules.some((rule) => rule.id === selectedRuleId) ? selectedRuleId : rules[0]?.id || "";
  const selectedRule = rules.find((rule) => rule.id === activeRuleId) || null;
  const sortedRules = useMemo(() => [...rules].sort((left, right) => left.priority - right.priority), [rules]);
  const variables = useMemo(() => {
    const combined = [...BUILT_IN_DECISION_VARIABLES, ...(config.decisions.variables || [])];
    return [...new Map(combined.map((item) => [item.key, item])).values()];
  }, [config.decisions.variables]);

  const updateDecisions = (patch) => set(["decisions"], { ...config.decisions, ...patch });
  const updateRules = (nextRules) => updateDecisions({ rules: nextRules });
  const updateRule = (ruleId, patch) => updateRules(rules.map((rule) => rule.id === ruleId ? { ...rule, ...patch } : rule));
  const addRule = () => {
    const id = uid("rule");
    const nextRule = {
      id,
      name: `Decision ${rules.length + 1}`,
      description: "",
      enabled: true,
      priority: Math.min(999, Math.max(1, ...rules.map((rule) => rule.priority + 10), 10)),
      match: "all",
      conditions: [{ id: uid("condition"), field: "page.path", operator: "contains", value: "/" }],
      actions: [{ id: uid("action"), type: "visibility", value: "visible", valueLabel: "" }],
    };
    updateDecisions({ enabled: true, rules: [...rules, nextRule] });
    setSelectedRuleId(id);
  };
  const cloneRule = (rule) => {
    const id = uid("rule");
    const copy = structuredClone(rule);
    copy.id = id;
    copy.name = `${rule.name} copy`;
    copy.priority = Math.min(999, rule.priority + 1);
    copy.conditions = copy.conditions.map((condition) => ({ ...condition, id: uid("condition") }));
    copy.actions = copy.actions.map((action) => ({ ...action, id: uid("action") }));
    updateRules([...rules, copy]);
    setSelectedRuleId(id);
  };
  const deleteRule = (rule) => {
    updateRules(rules.filter((candidate) => candidate.id !== rule.id));
    setSelectedRuleId("");
  };
  const updateContext = (key, value) => set(["preview", "decisionContext"], { ...config.preview.decisionContext, [key]: value });
  const addVariable = () => {
    const number = (config.decisions.variables?.length || 0) + 1;
    updateDecisions({ variables: [...config.decisions.variables, { id: uid("variable"), key: `custom.variable_${number}`, label: `Custom variable ${number}`, type: "string", source: "host" }] });
  };
  const updateVariable = (id, patch) => {
    const current = config.decisions.variables.find((variable) => variable.id === id);
    const nextVariables = config.decisions.variables.map((variable) =>
      variable.id === id ? { ...variable, ...patch } : variable
    );
    if (!current || !patch.key || patch.key === current.key) {
      updateDecisions({ variables: nextVariables });
      return;
    }
    const previousToken = `{{${current.key}}}`;
    const nextToken = `{{${patch.key}}}`;
    updateDecisions({
      variables: nextVariables,
      rules: rules.map((rule) => ({
        ...rule,
        conditions: rule.conditions.map((condition) =>
          condition.field === current.key ? { ...condition, field: patch.key } : condition
        ),
        actions: rule.actions.map((action) =>
          typeof action.value === "string" && action.value.includes(previousToken)
            ? { ...action, value: action.value.split(previousToken).join(nextToken) }
            : action
        ),
      })),
    });
  };
  const variableReferenced = (key) => rules.some((rule) =>
    rule.conditions.some((condition) => condition.field === key) ||
    rule.actions.some((action) =>
      typeof action.value === "string" && action.value.includes(`{{${key}}}`)
    )
  );

  return (
    <aside className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-background">
      <div className="border-b px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="flex items-center gap-2 font-semibold"><GitBranch className="size-4" /> Rules & decisions</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Evaluate context from top to bottom. The first matching rule wins.</p></div>
          <Switch checked={config.decisions.enabled} onCheckedChange={(enabled) => updateDecisions({ enabled })} aria-label="Enable decision engine" />
        </div>
      </div>
      <div className="min-h-0 min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden overflow-y-auto p-4 pb-10">
        <section className="min-w-0 max-w-full overflow-hidden rounded-xl border bg-gradient-to-br from-primary/10 via-background to-background shadow-sm">
          <div className="flex items-start justify-between gap-3 p-4">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><ResultBadge result={result} /><span className="text-[11px] text-muted-foreground">Live simulator</span></div><p className="mt-2 truncate text-sm font-semibold">{result.matchedRule?.name || "Configured defaults apply"}</p><p className="mt-1 text-xs text-muted-foreground">{result.visible ? `${result.channels.join(" + ") || "No channels"} · ${result.locale}` : "The launcher and panel are not rendered"}</p></div>
            <div className={`grid size-9 shrink-0 place-items-center rounded-full ${result.visible ? "bg-primary text-primary-foreground" : "bg-red-100 text-red-700"}`}>{result.visible ? <CheckCircle2 className="size-5" /> : <EyeOff className="size-5" />}</div>
          </div>
          <div className="flex flex-wrap gap-1.5 border-t bg-background/70 px-4 py-2.5 text-[10px]">
            <Badge variant="outline">View: {result.surface}</Badge>
            {result.routeQueue && <Badge variant="outline">Queue: {result.routeQueue.name}</Badge>}
            {result.launcherDelaySeconds > 0 && <Badge variant="outline">Delay: {result.launcherDelaySeconds}s</Badge>}
          </div>
          <div className="border-t p-3"><Button className="w-full" size="sm" onClick={onRunSimulation}><Play className="size-4" /> Run simulation in preview</Button></div>
        </section>

        <section className="min-w-0 max-w-full space-y-3">
          <div className="flex items-center justify-between"><div><h3 className="text-sm font-semibold">Test context</h3><p className="text-[11px] text-muted-foreground">Changes are evaluated instantly.</p></div><Switch checked={config.preview.simulateDecisions} onCheckedChange={(value) => set(["preview", "simulateDecisions"], value)} aria-label="Simulate decisions" /></div>
          <div className="grid min-w-0 max-w-full gap-2 rounded-xl border bg-muted/20 p-3">
            {variables.map((variable) => {
              const value = config.preview.decisionContext[variable.key] ?? (variable.type === "boolean" ? false : "");
              return <div key={variable.key} className="grid min-w-0 max-w-full gap-1"><span className="truncate text-[11px] font-medium">{variable.label} <code className="font-normal text-muted-foreground">{variable.key}</code></span>{variable.type === "boolean" ? <div className="flex h-9 min-w-0 items-center justify-between rounded-md border bg-background px-3 text-xs"><span>{value ? "True" : "False"}</span><Switch checked={Boolean(value)} onCheckedChange={(next) => updateContext(variable.key, next)} /></div> : <Input className="h-9 min-w-0 max-w-full bg-background" type={variable.type === "number" ? "number" : "text"} value={value} onChange={(event) => updateContext(variable.key, variable.type === "number" ? Number(event.target.value) : event.target.value)} />}</div>;
            })}
          </div>
        </section>

        <section className="min-w-0 max-w-full space-y-3">
          <div className="flex min-w-0 items-center justify-between gap-2"><div className="min-w-0"><h3 className="text-sm font-semibold">Decision rules</h3><p className="truncate text-[11px] text-muted-foreground">Lower priority runs first.</p></div><Button className="shrink-0" size="sm" variant="outline" onClick={addRule}><Plus className="size-4" /> Rule</Button></div>
          {!rules.length && <button type="button" onClick={addRule} className="grid w-full place-items-center rounded-xl border border-dashed p-6 text-center transition-colors hover:border-primary hover:bg-primary/5"><GitBranch className="mb-2 size-6 text-primary" /><span className="text-sm font-medium">Create your first decision</span><span className="mt-1 text-xs text-muted-foreground">Control targeting, UI and routing from one place.</span></button>}
          {rules.length > 0 && (
            <Popover open={rulesOpen} onOpenChange={setRulesOpen}>
              <PopoverTrigger asChild>
                <button type="button" role="combobox" aria-expanded={rulesOpen} aria-controls="widget-decision-rule-list" aria-label="Select decision rule" className="block w-full min-w-0 max-w-full rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                  <DecisionRuleCard
                    rule={selectedRule}
                    trace={result.traces.find((item) => item.rule.id === selectedRule?.id)}
                    active
                    expanded={rulesOpen}
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-[var(--radix-popover-trigger-width)] max-w-[var(--radix-popover-content-available-width)] overflow-hidden p-0">
                <Command>
                  <CommandInput placeholder="Search rules…" />
                  <CommandList className="max-h-80 overflow-x-hidden">
                    <CommandEmpty>No decision rules found.</CommandEmpty>
                    {sortedRules.map((rule) => {
                      const active = activeRuleId === rule.id;
                      const trace = result.traces.find((item) => item.rule.id === rule.id);
                      return (
                        <CommandItem
                          key={rule.id}
                          value={`${rule.name} priority ${rule.priority}`}
                          keywords={[rule.description, `P${rule.priority}`]}
                          onSelect={() => {
                            setSelectedRuleId(rule.id);
                            setRulesOpen(false);
                          }}
                          className="min-w-0 max-w-full p-1 data-[selected=true]:bg-transparent"
                        >
                          <span className="block min-w-0 max-w-full flex-1">
                            <DecisionRuleCard rule={rule} trace={trace} active={active} expanded={active} />
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
        </section>

        {selectedRule && <section className="min-w-0 max-w-full space-y-4 overflow-hidden rounded-xl border p-3 shadow-sm">
          <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Edit decision</h3><div className="flex gap-1"><Button size="icon" variant="ghost" className="size-8" onClick={() => cloneRule(selectedRule)} aria-label="Duplicate rule"><Copy className="size-4" /></Button><Button size="icon" variant="ghost" className="size-8 text-destructive hover:text-destructive" onClick={() => deleteRule(selectedRule)} aria-label="Delete rule"><Trash2 className="size-4" /></Button></div></div>
          <Labeled label="Name"><Input className="h-9" value={selectedRule.name} onChange={(event) => updateRule(selectedRule.id, { name: event.target.value })} /></Labeled>
          <Labeled label="Description"><Textarea rows={2} value={selectedRule.description} onChange={(event) => updateRule(selectedRule.id, { description: event.target.value })} placeholder="Explain the business intent…" /></Labeled>
          <div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)_88px] gap-2"><Labeled label="Match"><SelectBox value={selectedRule.match} onChange={(match) => updateRule(selectedRule.id, { match })}><SelectItem value="all">All conditions</SelectItem><SelectItem value="any">Any condition</SelectItem></SelectBox></Labeled><Labeled label="Priority"><Input className="h-9 min-w-0 max-w-full" type="number" min="1" max="999" value={selectedRule.priority} onChange={(event) => updateRule(selectedRule.id, { priority: Math.max(1, Math.min(999, Number(event.target.value) || 1)) })} /></Labeled></div>
          <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2"><span className="text-xs font-medium">Rule enabled</span><Switch checked={selectedRule.enabled} onCheckedChange={(enabled) => updateRule(selectedRule.id, { enabled })} /></div>

          <div className="space-y-2"><div className="flex items-center justify-between"><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">If</h4><Button size="sm" variant="ghost" onClick={() => updateRule(selectedRule.id, { conditions: [...selectedRule.conditions, { id: uid("condition"), field: "customer.segment", operator: "equals", value: "" }] })}><Plus className="size-3.5" /> Condition</Button></div>{selectedRule.conditions.map((condition, index) => {
            const variable = variables.find((item) => item.key === condition.field);
            const update = (patch) => updateRule(selectedRule.id, { conditions: selectedRule.conditions.map((item) => item.id === condition.id ? { ...item, ...patch } : item) });
            const noValue = condition.operator === "exists" || condition.operator === "not-exists";
            return <div key={condition.id} className="min-w-0 max-w-full space-y-2 overflow-hidden rounded-lg border bg-muted/15 p-2.5"><div className="flex items-center justify-between"><Badge variant="secondary" className="text-[10px]">{index + 1}</Badge>{selectedRule.conditions.length > 1 && <Button size="icon" variant="ghost" className="size-7" onClick={() => updateRule(selectedRule.id, { conditions: selectedRule.conditions.filter((item) => item.id !== condition.id) })}><Trash2 className="size-3.5" /></Button>}</div><SelectBox value={condition.field} onChange={(field) => update({ field, value: variables.find((item) => item.key === field)?.type === "boolean" ? true : "" })}>{variables.map((item) => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}</SelectBox><SelectBox value={condition.operator} onChange={(operator) => update({ operator })}>{DECISION_OPERATORS.map((operator) => <SelectItem key={operator.value} value={operator.value}>{operator.label}</SelectItem>)}</SelectBox>{!noValue && (variable?.type === "boolean" ? <SelectBox value={String(condition.value)} onChange={(value) => update({ value: value === "true" })}><SelectItem value="true">True</SelectItem><SelectItem value="false">False</SelectItem></SelectBox> : <Input className="h-9 min-w-0 max-w-full bg-background" type={variable?.type === "number" ? "number" : "text"} value={condition.value ?? ""} onChange={(event) => update({ value: variable?.type === "number" ? Number(event.target.value) : event.target.value })} placeholder={condition.operator === "in" ? "vip, premium, private" : "Comparison value"} />)}</div>;
          })}</div>

          <div className="space-y-2"><div className="flex items-center justify-between"><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Then</h4><Button size="sm" variant="ghost" onClick={() => updateRule(selectedRule.id, { actions: [...selectedRule.actions, { id: uid("action"), type: "channels", value: "both", valueLabel: "" }] })}><Plus className="size-3.5" /> Action</Button></div>{selectedRule.actions.map((action, index) => {
            const update = (patch) => updateRule(selectedRule.id, { actions: selectedRule.actions.map((item) => item.id === action.id ? { ...item, ...patch } : item) });
            return <div key={action.id} className="min-w-0 max-w-full space-y-2 overflow-hidden rounded-lg border bg-primary/[0.025] p-2.5"><div className="flex min-w-0 items-center gap-2"><span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><ActionIcon type={action.type} /></span><span className="min-w-0 flex-1 text-xs font-medium">Action {index + 1}</span>{selectedRule.actions.length > 1 && <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={() => updateRule(selectedRule.id, { actions: selectedRule.actions.filter((item) => item.id !== action.id) })}><Trash2 className="size-3.5" /></Button>}</div><SelectBox value={action.type} onChange={(type) => update({ type, value: initialActionValue(type, config), valueLabel: "" })}>{DECISION_ACTION_TYPES.map((type) => <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>)}</SelectBox>{actionValueEditor(action, config, update)}</div>;
          })}</div>
        </section>}

        <section className="min-w-0 max-w-full space-y-3 border-t pt-5"><div className="flex min-w-0 items-center justify-between gap-2"><div className="min-w-0"><h3 className="text-sm font-semibold">Context catalog</h3><p className="truncate text-[11px] text-muted-foreground">Values supplied by the host page.</p></div><Button className="shrink-0" size="sm" variant="outline" onClick={addVariable}><Plus className="size-4" /> Variable</Button></div>{config.decisions.variables.map((variable) => { const referenced = variableReferenced(variable.key); return <div key={variable.id} className="grid min-w-0 max-w-full gap-2 overflow-hidden rounded-lg border p-2.5"><div className="flex min-w-0 gap-2"><Input className="h-8 min-w-0 max-w-full" value={variable.label} onChange={(event) => updateVariable(variable.id, { label: event.target.value })} /><Button size="icon" variant="ghost" className="size-8 shrink-0" disabled={referenced} title={referenced ? "Remove this variable from decision conditions and actions first" : "Delete variable"} onClick={() => updateDecisions({ variables: config.decisions.variables.filter((item) => item.id !== variable.id) })}><Trash2 className="size-3.5" /></Button></div><Input className="h-8 min-w-0 max-w-full font-mono text-xs" value={variable.key} onChange={(event) => updateVariable(variable.id, { key: event.target.value })} /><div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2"><SelectBox value={variable.type} onChange={(type) => updateVariable(variable.id, { type })}><SelectItem value="string">Text</SelectItem><SelectItem value="number">Number</SelectItem><SelectItem value="boolean">True / false</SelectItem></SelectBox><SelectBox value={variable.source} onChange={(source) => updateVariable(variable.id, { source })}><SelectItem value="host">Host context</SelectItem><SelectItem value="query">URL query</SelectItem><SelectItem value="cookie">Cookie</SelectItem><SelectItem value="data-layer">Data layer</SelectItem></SelectBox></div></div>; })}</section>

        <section className="rounded-xl border bg-muted/20 p-3"><div className="flex items-center gap-2 text-xs font-semibold"><Braces className="size-4" /> Host page API</div><code className="mt-2 block break-all rounded-md bg-background p-2 text-[10px] leading-relaxed">window.TelnyxWidgetContext = {`{ "customer.segment": "vip" }`}</code><p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">Use signed server-provided context for security-sensitive decisions. Browser context is suitable for presentation and allowed-queue selection, not authorization.</p></section>
      </div>
    </aside>
  );
}
