"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconPlus, IconTrash, IconLoader2 } from "@tabler/icons-react";

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

const TRIGGERS = [
  { value: "on_fill", label: "When this slot is filled", hint: "Runs as soon as the caller/LLM or agent provides this value." },
  { value: "on_result", label: "After another binding returns", hint: "Chains off an earlier MCP result." },
  { value: "on_complete", label: "Automatically when required inputs are filled", hint: "For automatic enrichment that is safe to run without agent confirmation." },
  { value: "manual_submit", label: "Manual confirmed submit", hint: "Shows an agent submit/confirmation action after required inputs are ready. Use this for create_transport." },
];

/** Rows <-> object, so the editor can hold duplicate/blank keys while typing. */
function toRows(map) {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map).map(([key, value]) => ({
    key,
    value: typeof value === "object" ? JSON.stringify(value) : String(value ?? ""),
  }));
}

/**
 * @param {Object} schemaProperties tool schema properties, so values retain the
 *   type declared by the MCP tool. Templates remain strings inside structured
 *   values and are resolved recursively at invocation time.
 */
function fromRows(rows, schemaProperties = {}) {
  const out = {};
  for (const row of rows) {
    const key = String(row.key || "").trim();
    if (!key) continue;
    const raw = String(row.value ?? "").trim();
    const declared = schemaProperties?.[key]?.type;

    // Schema type wins over the presence of a template marker. A JSON object
    // such as {"facilityId":"{{slots.facility_id}}"} must remain an object;
    // the runtime recursively resolves the nested string later.
    if (declared === "object" || declared === "array") {
      if (raw === "") {
        out[key] = raw;
      } else {
        try {
          const parsed = JSON.parse(raw);
          const typeMatches = declared === "array"
            ? Array.isArray(parsed)
            : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
          out[key] = typeMatches ? parsed : raw;
        } catch {
          // Keep invalid JSON as text while the admin is typing. Runtime schema
          // validation will still reject it if they save an invalid value.
          out[key] = raw;
        }
      }
    } else if (declared === "string" || raw.includes("{{")) {
      out[key] = raw;
    } else if (declared === "boolean") {
      out[key] = raw === "true" ? true : raw === "false" ? false : raw;
    } else if (raw === "true" || raw === "false") {
      out[key] = raw === "true";
    } else if (declared === "number" || declared === "integer") {
      out[key] = raw === "" ? raw : Number(raw);
    } else if (raw !== "" && !Number.isNaN(Number(raw))) {
      out[key] = Number(raw);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

function KeyValueRows({ rows, onChange, keyPlaceholder, valuePlaceholder, addLabel }) {
  const [draftRows, setDraftRows] = useState(rows);

  // Blank rows are intentionally not persisted by fromRows(). Keep them local
  // while the admin types so Add argument / Add output does not immediately
  // disappear on the next render.
  useEffect(() => {
    setDraftRows((current) => {
      const committedDraft = current.filter((row) => String(row.key || "").trim());
      return JSON.stringify(committedDraft) === JSON.stringify(rows) ? current : rows;
    });
  }, [rows]);

  const updateRows = (next) => {
    setDraftRows(next);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {draftRows.map((row, index) => (
        <div key={index} className="flex gap-2">
          <Input
            className="flex-1 font-mono text-xs"
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(e) => {
              const next = [...draftRows];
              next[index] = { ...next[index], key: e.target.value };
              updateRows(next);
            }}
          />
          <Input
            className="flex-1 font-mono text-xs"
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(e) => {
              const next = [...draftRows];
              next[index] = { ...next[index], value: e.target.value };
              updateRows(next);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label="Remove row"
            onClick={() => updateRows(draftRows.filter((_, i) => i !== index))}
          >
            <IconTrash className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setDraftRows((current) => [...current, { key: "", value: "" }])}
      >
        <IconPlus className="size-4 mr-1" />
        {addLabel}
      </Button>
    </div>
  );
}

/**
 * Attaches an MCP tool to a workflow slot.
 *
 * The binding shape is validated at run time by lib/agent-assist/slot-mcp-runner.mjs;
 * this editor only has to produce it.
 */
export default function SlotMcpBindingEditor({ value, onChange, slotName, itemId, availableSlots = [] }) {
  const binding = value || null;
  const enabled = Boolean(binding);

  const [servers, setServers] = useState([]);
  const [tools, setTools] = useState([]);
  const [loadingServers, setLoadingServers] = useState(false);
  const [loadingTools, setLoadingTools] = useState(false);
  const latestServerRef = useRef("");

  const serverId = binding?.server_id || "";
  const toolName = binding?.tool_name || "";
  latestServerRef.current = serverId;

  // Remount boundary for the row editors below (Codex review on #1375,
  // round 2). slotName alone is wrong on two counts: it's edited on every
  // keystroke while renaming a slot (remounting mid-type and discarding a
  // draft row), and it only has a non-unique DB index, so two items sharing
  // a name would incorrectly share drafts. itemId is the item's stable,
  // unique primary key. server_id/tool_name are included too because
  // selecting a different server/tool resets arguments/outputs to {} within
  // the SAME item (see the onValueChange below) — the reconciliation effect
  // in KeyValueRows can't tell that apart from an unrelated re-render when
  // both the stale draft's committed form and the new rows are [].
  const rowEditorKey = `${itemId ?? ""}:${serverId}:${toolName}`;

  const patch = useCallback(
    (changes) => onChange({ ...(binding || {}), ...changes }),
    [binding, onChange],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      setLoadingServers(true);
      try {
        const response = await fetch("/api/admin/mcp-servers?page=1&pageSize=100", { cache: "no-store" });
        const data = await response.json();
        if (cancelled || !response.ok) return;
        setServers(Array.isArray(data.rows) ? data.rows : []);
      } catch {
        if (!cancelled) setServers([]);
      } finally {
        if (!cancelled) setLoadingServers(false);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !serverId) {
      setTools([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingTools(true);
      try {
        const response = await fetch(`/api/admin/mcp-servers/${encodeURIComponent(serverId)}/tools`, { cache: "no-store" });
        const data = await response.json();
        if (cancelled || latestServerRef.current !== serverId || !response.ok) return;
        setTools(Array.isArray(data.tools) ? data.tools : []);
      } catch {
        if (!cancelled) setTools([]);
      } finally {
        if (!cancelled) setLoadingTools(false);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, serverId]);

  const selectedTool = useMemo(() => tools.find((tool) => tool.name === toolName) || null, [tools, toolName]);
  const schemaProperties = useMemo(() => {
    const schema = selectedTool?.input_schema || selectedTool?.inputSchema || {};
    return schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  }, [selectedTool]);

  const argumentRows = useMemo(() => toRows(binding?.arguments), [binding?.arguments]);
  const outputRows = useMemo(() => toRows(binding?.outputs), [binding?.outputs]);

  function selectTool(nextToolName) {
    const tool = tools.find((t) => t.name === nextToolName);
    const schema = tool?.input_schema || tool?.inputSchema || {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    const seeded = {};
    for (const name of required) {
      if (name === "systemId") continue;
      seeded[name] = binding?.arguments?.[name] ?? "";
    }
    const defaultResultKey = slotName ? `${slotName}_${nextToolName}` : nextToolName;
    patch({
      tool_name: nextToolName,
      result_key: binding?.result_key || defaultResultKey,
      arguments: { ...seeded, ...(binding?.arguments || {}) },
    });
  }

  if (!enabled) {
    return (
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">MCP Tool Binding</Label>
            <p className="text-xs text-muted-foreground">Attach an MCP tool to this workflow slot.</p>
          </div>
          <Switch checked={false} aria-label="Enable MCP tool binding" onCheckedChange={() => onChange({ server_id: "", tool_name: "", trigger: "on_fill", arguments: {}, outputs: {} })} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 border-t pt-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">MCP Tool Binding</Label>
          <p className="text-xs text-muted-foreground">Runs during the interaction and can write explicitly mapped MCP-derived slots.</p>
        </div>
        <Switch checked aria-label="Disable MCP tool binding" onCheckedChange={() => onChange(null)} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="mcp-binding-server">MCP Server</Label>
        <Select value={serverId || undefined} onValueChange={(id) => patch({ server_id: id, tool_name: "", arguments: {}, outputs: {} })}>
          <SelectTrigger id="mcp-binding-server"><SelectValue placeholder={loadingServers ? "Loading servers…" : "Select MCP server"} /></SelectTrigger>
          <SelectContent>{servers.map((server) => <SelectItem key={server.id} value={server.id}>{server.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="mcp-binding-tool">Tool</Label>
        <Select value={toolName || undefined} onValueChange={selectTool} disabled={!serverId}>
          <SelectTrigger id="mcp-binding-tool"><SelectValue placeholder={loadingTools ? "Loading tools…" : serverId ? "Select tool" : "Select a server first"} /></SelectTrigger>
          <SelectContent>{tools.map((tool) => <SelectItem key={tool.name} value={tool.name}>{tool.name}</SelectItem>)}</SelectContent>
        </Select>
        {loadingTools && <p className="text-xs text-muted-foreground flex items-center gap-1"><IconLoader2 className="size-3 animate-spin" /> Loading tools…</p>}
        {selectedTool?.description && <p className="text-xs text-muted-foreground">{selectedTool.description}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="mcp-binding-trigger">Run</Label>
        <Select
          value={binding?.trigger || "on_fill"}
          onValueChange={(trigger) => patch({
            trigger,
            ...(trigger === "manual_submit" ? { execution_policy: "once_per_session" } : {}),
          })}
        >
          <SelectTrigger id="mcp-binding-trigger"><SelectValue /></SelectTrigger>
          <SelectContent>{TRIGGERS.map((trigger) => <SelectItem key={trigger.value} value={trigger.value}>{trigger.label}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{TRIGGERS.find((t) => t.value === (binding?.trigger || "on_fill"))?.hint}</p>
      </div>

      {binding?.trigger === "on_result" && (
        <div className="space-y-2">
          <Label htmlFor="mcp-binding-depends">Waits for result key</Label>
          <Input id="mcp-binding-depends" className="font-mono text-xs" value={binding?.depends_on || ""} placeholder="pickup_lookup" onChange={(e) => patch({ depends_on: e.target.value })} />
          <p className="text-xs text-muted-foreground">The <span className="font-mono">Result key</span> of the binding this one chains off.</p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="mcp-binding-policy">Repeat behaviour</Label>
        <Select
          value={binding?.execution_policy || (["on_complete", "manual_submit"].includes(binding?.trigger) ? "once_per_session" : "on_argument_change")}
          onValueChange={(execution_policy) => patch({ execution_policy })}
        >
          <SelectTrigger id="mcp-binding-policy"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="on_argument_change">Re-run when its inputs change</SelectItem>
            <SelectItem value="once_per_session">Run once per call</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Lookups should re-run when a value is corrected. Anything that submits or books should run once. An uncertain post-dispatch outcome is deliberately not retried automatically.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="mcp-binding-result-key">Result key</Label>
        <Input id="mcp-binding-result-key" className="font-mono text-xs" value={binding?.result_key || ""} placeholder={toolName || "lookup_addresses"} onChange={(e) => patch({ result_key: e.target.value })} />
        <p className="text-xs text-muted-foreground">Other bindings read this result as <span className="font-mono">{`{{mcp.${binding?.result_key || "key"}.0.field}}`}</span></p>
      </div>

      <div className="space-y-2">
        <Label>Arguments</Label>
        <KeyValueRows key={rowEditorKey} rows={argumentRows} onChange={(rows) => patch({ arguments: fromRows(rows, schemaProperties) })} keyPlaceholder="userAddress" valuePlaceholder={`{{slots.${slotName || "slot_name"}}}`} addLabel="Add argument" />
        <p className="text-xs text-muted-foreground"><span className="font-mono">{`{{slots.name}}`}</span> reads any filled slot, including values produced by an earlier MCP call. <span className="font-mono">{`{{mcp.key.0.field}}`}</span> reads the raw earlier MCP result. <span className="font-mono">systemId</span> is added automatically.</p>
      </div>

      <div className="space-y-2">
        <Label>Write results into slots</Label>
        <KeyValueRows key={rowEditorKey} rows={outputRows} onChange={(rows) => patch({ outputs: fromRows(rows) })} keyPlaceholder="pickup_facility_id" valuePlaceholder="0.facility_id" addLabel="Add output" />
        <p className="text-xs text-muted-foreground">These mappings define the MCP-derived fields. MCP writes only the slot names listed on the left; other slots remain conversation/LLM-driven. Agents can still manually edit an MCP-derived field, and that manual value is protected from later MCP overwrites.{availableSlots.length > 0 && <> Slots in this workflow: <span className="font-mono">{availableSlots.slice(0, 8).join(", ")}</span>.</>}</p>
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Let the agent choose between matches</Label>
          <Switch checked={Boolean(binding?.alternatives)} aria-label="Toggle agent choice for multiple matches" onCheckedChange={(on) => patch({ alternatives: on ? { path: "$", label: "", value: "", target_slot: "" } : null })} />
        </div>
        <p className="text-xs text-muted-foreground">When the tool returns more than one candidate, show them as choices instead of guessing. No derived output is filled until the agent picks.</p>
        {binding?.alternatives && (
          <div className="space-y-2 pt-1">
            <Input className="font-mono text-xs" placeholder="Label template — {{facility_name}} - {{city}}, {{state}}" value={binding.alternatives.label || ""} onChange={(e) => patch({ alternatives: { ...binding.alternatives, label: e.target.value } })} />
            <Input className="font-mono text-xs" placeholder="Value template — {{facility_id}}" value={binding.alternatives.value || ""} onChange={(e) => patch({ alternatives: { ...binding.alternatives, value: e.target.value } })} />
            <Input className="font-mono text-xs" placeholder="Optional write target — pickup_facility_id" value={binding.alternatives.target_slot || ""} onChange={(e) => patch({ alternatives: { ...binding.alternatives, target_slot: e.target.value } })} />
            <p className="text-xs text-muted-foreground">Leave target blank to display choices on this binding's item while writing only the declared output mappings. Set it only when the selected candidate value itself should populate a specific MCP field.</p>
          </div>
        )}
      </div>
    </div>
  );
}
