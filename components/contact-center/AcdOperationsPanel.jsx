"use client";

import MonitoringFilters from "./MonitoringFilters";
import { InteractionChannel } from "./InteractionChannel";
import { Skeleton } from "@/components/ui/skeleton";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconPhoneCheck,
  IconUsers,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function ageLabel(seconds) {
  const value = Number(seconds || 0);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  if (value < 86400) return `${Math.floor(value / 3600)}h`;
  return `${Math.floor(value / 86400)}d`;
}

function recoveryMessage(result) {
  if (!result) return "";
  if (result.recovered && result.action === "release_native_capacity") return `Stale ${result.channel || ""} capacity was released${result.agentReleased ? " and the agent is idle again" : ""}.`;
  if (result.recovered) return "Provider or local end evidence confirmed. Voice capacity was released.";
  if (result.state === "pending") return "One ended leg was confirmed. Capacity remains protected while other media is checked.";
  if (result.evidence === "provider_call_active") return "The exact provider call is still active. Capacity was retained.";
  if (result.evidence === "provider_call_unknown") return "No exact provider call is available for a safe check. Capacity was retained.";
  if (result.evidence === "provider_unavailable") return "Provider verification is unavailable. Capacity was retained.";
  return "The provider result was inconclusive. Capacity was retained.";
}

function Metric({ icon: Icon, label, value, detail }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function AcdOperationsPanel() {
  const request=useRef(null);
  const [channel,setChannel]=useState("all");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [busyTarget, setBusyTarget] = useState("");
  const [lastResult, setLastResult] = useState(null);

  const load = useCallback(async () => {
    request.current?.abort();const controller=new AbortController();request.current=controller;
    try {
      const response = await fetch(`/api/contact-center/acd/operations?channel=${channel}`, { cache: "no-store",signal:controller.signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      if(controller.signal.aborted)return;
      setData(value);
      setError("");
    } catch (err) {
      if(!request.current?.signal.aborted)setError(err.message);
    }
  }, [channel]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => {clearInterval(timer);request.current?.abort();};
  }, [load]);

  async function recover(targetId, native = false) {
    setBusyTarget(targetId);
    setError("");
    setLastResult(null);
    try {
      const response = await fetch("/api/contact-center/acd/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(native
          ? { action: "release_native_capacity", targetId, reason, requestId: crypto.randomUUID() }
          : { action: "recover_voice_capacity", targetId, reason, requestId: crypto.randomUUID() }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setLastResult(value);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyTarget("");
    }
  }

  const filters = <MonitoringFilters channel={channel} onChannelChange={value=>{setData(null);setChannel(value);}} onRefresh={load} loading={Boolean(busyTarget)} />;
  if(!data)return <div className="space-y-4">{filters}{error?<p role="alert" className="p-5 text-destructive">{error}<Button variant="outline" onClick={load}>Retry</Button></p>:<div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-32"/><Skeleton className="h-32"/><Skeleton className="h-64 md:col-span-2"/></div>}</div>;
  const voiceCapacity = data.voiceCapacity || [];
  const nativeCapacity = data.nativeCapacity || [];
  const attentionCount = voiceCapacity.filter((item) => item.needs_attention).length + nativeCapacity.filter((item) => item.needs_attention).length;
  const agentCount = new Set([...voiceCapacity, ...nativeCapacity].map((item) => item.agent_id).filter(Boolean)).size;
  const reasonMissing = reason.trim().length < 5;

  return (
    <div className="space-y-4">
      {filters}
      {!data ? <Skeleton className="h-44 w-full"/> : <Card><CardContent className="space-y-4 p-5"><h3 className="text-sm font-semibold">Current workload by channel</h3><div className="grid gap-3 sm:grid-cols-3">{data.channelHealth?.map(row=><div key={`${row.channel}:${row.state}`} className="rounded-xl border p-3"><InteractionChannel channel={row.channel} label/><p className="mt-2 text-sm">{row.total} · {row.state}</p></div>)}</div>{!data.channelHealth?.length&&<p className="text-xs text-muted-foreground">No current work in this channel.</p>}{data.emailHealth?.length>0&&<div><p className="mb-2 text-xs font-semibold">Email sends · last 24 hours</p><div className="flex flex-wrap gap-2">{data.emailHealth.map(row=><Badge variant="outline" key={row.status}>{row.status}: {row.total}</Badge>)}</div></div>}<p className="text-xs text-muted-foreground">Global event stream: {data.outbox?.pending??'—'} awaiting publication.</p></CardContent></Card>}
      <div className="rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Voice capacity is released only against provider end evidence and is shown independently of the channel filter. Chat, messaging and video capacity is released when no live offer or assignment owns it.</div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric icon={IconPhoneCheck} label="Voice reservations" value={voiceCapacity.length} detail="Current capacity owners" />
        <Metric icon={IconUsers} label="Agents using capacity" value={agentCount} detail="Agents with a reservation on any channel" />
        <Metric icon={IconAlertTriangle} label="Needs attention" value={attentionCount} detail="Cleanup requested or overdue" />
      </div>

      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="text-base">Agent voice capacity</CardTitle>
          <p className="text-sm text-muted-foreground">
            Check a reported blocked agent. Capacity is released only when the exact provider call is confirmed ended.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {voiceCapacity.length ? (
            <div>
              <Input
                aria-label="Recovery audit note"
                placeholder="Audit note, e.g. Agent is Busy without an active interaction"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Required for the audit log; minimum 5 characters.
              </p>
            </div>
          ) : null}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {lastResult ? (
            <div aria-live="polite" className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${lastResult.recovered ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
              {lastResult.recovered ? <IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
              <span>{recoveryMessage(lastResult)}</span>
            </div>
          ) : null}
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Capacity state</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead>Last check</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {voiceCapacity.length ? voiceCapacity.map((item) => {
                  const agentName = [item.first_name, item.last_name].filter(Boolean).join(" ") || item.username || item.agent_id;
                  const checking = busyTarget === item.reservation_id;
                  return (
                    <TableRow key={item.reservation_id}>
                      <TableCell>
                        <div className="font-medium">{agentName}</div>
                        <div className="text-xs text-muted-foreground">{item.manual_status || item.workflow_state || "unknown"}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={item.needs_attention ? "border-amber-500/40 text-amber-700 dark:text-amber-300" : ""}>
                          {item.needs_attention ? "needs attention" : item.reservation_state}
                        </Badge>
                      </TableCell>
                      <TableCell>{ageLabel(item.age_seconds)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.last_recovery_at ? (item.last_recovery_result?.evidence || item.last_recovery_result?.state || "recorded") : "Not checked"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={Boolean(busyTarget) || reasonMissing}
                          onClick={() => recover(item.reservation_id)}
                        >
                          {checking ? "Checking…" : "Check & recover"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                }) : (
                  <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No agent voice capacity is currently reserved.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="text-base">Agent chat, messaging and video capacity</CardTitle>
          <p className="text-sm text-muted-foreground">
            A reservation stays valid while an offer is ringing or a text assignment is open. Rows marked “needs attention” keep the agent Busy without either and can be released here; the reconciler also releases them on its own once the owning execution has finished.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {nativeCapacity.length && !voiceCapacity.length ? (
            <div>
              <Input
                aria-label="Recovery audit note"
                placeholder="Audit note, e.g. Agent is Busy without an active interaction"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">Required for the audit log; minimum 5 characters.</p>
            </div>
          ) : null}
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Owned by</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nativeCapacity.length ? nativeCapacity.map((item) => {
                  const agentName = [item.first_name, item.last_name].filter(Boolean).join(" ") || item.username || item.agent_id;
                  const owner = item.terminal_at ? `work item ${item.work_state}` : item.assignment_state ? `assignment ${item.assignment_state}` : item.offer_state ? `offer ${item.offer_state}` : "nothing";
                  return (
                    <TableRow key={item.reservation_id}>
                      <TableCell>
                        <div className="font-medium">{agentName}</div>
                        <div className="text-xs text-muted-foreground">{item.manual_status || item.workflow_state || "unknown"}</div>
                      </TableCell>
                      <TableCell><InteractionChannel channel={item.channel} label /></TableCell>
                      <TableCell>
                        <Badge variant="outline" className={item.needs_attention ? "border-amber-500/40 text-amber-700 dark:text-amber-300" : ""}>
                          {item.needs_attention ? `needs attention · ${owner}` : owner}
                        </Badge>
                      </TableCell>
                      <TableCell>{ageLabel(item.age_seconds)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={Boolean(busyTarget) || reasonMissing || !item.needs_attention}
                          onClick={() => recover(item.reservation_id, true)}
                        >
                          {busyTarget === item.reservation_id ? "Releasing…" : "Release capacity"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                }) : (
                  <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No chat, messaging or video capacity is currently reserved.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
