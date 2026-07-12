"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconMessages, IconRefresh } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function MessagingSettingsPanel({ values, setValues }) {
  const [profiles, setProfiles] = useState([]);
  const [numbers, setNumbers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const messaging = values.messaging || {};
  const enabled = (values.enabled_features || []).includes("messaging");
  const profileId = messaging.default_messaging_profile_id || "";
  function patch(next) { setValues((current) => ({ ...current, messaging: { ...(current.messaging || {}), ...next } })); }
  function toggleFeature(checked) { setValues((current) => ({ ...current, enabled_features: checked ? [...new Set([...(current.enabled_features || []), "messaging"])] : (current.enabled_features || []).filter((item) => item !== "messaging") })); }
  const loadNumbers = useCallback(async () => { setLoading(true); try { const response = await fetch(`/api/admin/numbers?page=1&pageSize=100${search ? `&phone_number=${encodeURIComponent(search)}` : ""}`, { cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Failed to load numbers"); setNumbers(Array.isArray(data.data) ? data.data : []); } catch (error) { notify({ title: "Could not load numbers", description: error.message, variant: "error" }); } finally { setLoading(false); } }, [search]);
  useEffect(() => { fetch("/api/admin/messaging-profiles", { cache: "no-store" }).then((response) => response.json()).then((data) => setProfiles(Array.isArray(data.data) ? data.data : [])).catch(() => setProfiles([])); }, []);
  useEffect(() => { if (enabled) loadNumbers(); }, [enabled, loadNumbers]);
  const assigned = useMemo(() => numbers.filter((number) => String(number.messaging_profile_id || number.messaging?.messaging_profile_id || "") === String(profileId)), [numbers, profileId]);
  async function assign(number, nextProfileId) { try { const response = await fetch(`/api/admin/numbers/${encodeURIComponent(number.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messaging_profile_id: nextProfileId || null }) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "Assignment failed"); notify({ title: nextProfileId ? "Messaging number assigned" : "Messaging number unassigned", description: number.phone_number, variant: "success" }); await loadNumbers(); } catch (error) { notify({ title: "Number update failed", description: error.message, variant: "error" }); } }
  return <div className="space-y-4"><Card><CardHeader><CardTitle>Messaging</CardTitle><CardDescription>Enable messaging and select the profile used by the assistant.</CardDescription></CardHeader><CardContent className="space-y-5"><div className="flex items-center justify-between rounded-lg border p-4"><div><div className="font-medium">Enable messaging</div><div className="text-xs text-muted-foreground">Allow SMS and supported messaging conversations.</div></div><Switch checked={enabled} onCheckedChange={toggleFeature} /></div>{enabled ? <div className="space-y-2"><Label>Default messaging profile *</Label><Select value={profileId || ""} onValueChange={(value) => patch({ default_messaging_profile_id: value })}><SelectTrigger><SelectValue placeholder="Select messaging profile" /></SelectTrigger><SelectContent>{profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name || profile.id}</SelectItem>)}</SelectContent></Select></div> : null}</CardContent></Card>{enabled ? <Card><CardHeader><div className="flex items-start justify-between gap-4"><div><CardTitle>Messaging numbers</CardTitle><CardDescription className="mt-1">Assign Telnyx numbers to the selected messaging profile.</CardDescription></div><Badge variant="secondary">{assigned.length} assigned</Badge></div></CardHeader><CardContent className="space-y-4"><div className="flex gap-2"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search phone number" /><Button variant="outline" onClick={loadNumbers} disabled={loading}><IconRefresh className="size-4" />Refresh</Button></div><div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>Number</TableHead><TableHead>Type</TableHead><TableHead>Current profile</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader><TableBody>{numbers.map((number) => { const current = number.messaging_profile_id || number.messaging?.messaging_profile_id || ""; const isAssigned = Boolean(profileId) && String(current) === String(profileId); return <TableRow key={number.id}><TableCell className="font-medium"><div className="flex items-center gap-2"><IconMessages className="size-4 text-sky-500" />{number.phone_number}</div></TableCell><TableCell>{number.number_type || "—"}</TableCell><TableCell>{number.messaging_profile_name || current || "Unassigned"}</TableCell><TableCell className="text-right"><Button size="sm" variant={isAssigned ? "outline" : "default"} disabled={!profileId} onClick={() => assign(number, isAssigned ? null : profileId)}>{isAssigned ? "Unassign" : "Assign"}</Button></TableCell></TableRow>; })}{!numbers.length ? <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">{loading ? "Loading…" : "No numbers found"}</TableCell></TableRow> : null}</TableBody></Table></div></CardContent></Card> : null}</div>;
}
