"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { IconEdit, IconHelpCircle, IconPlus } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";
import { useHelp } from "@/components/help/HelpProvider";

const memberLabel = (member) => {
  const name = [member.firstName ?? member.first_name, member.lastName ?? member.last_name].filter(Boolean).join(" ");
  return name ? `${name} (${member.username})` : member.username;
};

/**
 * Create / edit a team and pick its members. Members are the users whose
 * `agent_groups` contain the team; the list is saved with the team.
 */
export default function TeamEditSheet({ open, onOpenChange, teamId, onSave, readOnly = false }) {
  const { openHelp, registerHelpPortalContainer } = useHelp();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [members, setMembers] = useState([]); // { id, username, firstName, lastName }
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [searching, setSearching] = useState(false);

  const memberIds = useMemo(() => new Set(members.map((m) => String(m.id))), [members]);

  const loadTeam = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/teams/${encodeURIComponent(teamId)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to load team");
      const team = data.team || data;
      setName(team.name || "");
      setDescription(team.description || "");
      setIsActive(team.isActive !== false);
      setMembers(team.members || []);
    } catch (error) {
      notify({ title: "Failed to load team", description: error.message, variant: "error" });
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setCandidates([]);
    if (teamId) loadTeam();
    else {
      setName("");
      setDescription("");
      setIsActive(true);
      setMembers([]);
    }
  }, [loadTeam, open, teamId]);

  // Candidate users come from the users API; the search is debounced.
  useEffect(() => {
    if (!open || readOnly) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const sp = new URLSearchParams({ page: "1", pageSize: "50" });
        if (search.trim()) sp.set("q", search.trim());
        const res = await fetch(`/api/admin/users?${sp.toString()}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setCandidates((data.rows || []).map((row) => ({ id: row.id, username: row.username, firstName: row.first_name, lastName: row.last_name })));
        }
      } catch {
        if (!cancelled) setCandidates([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, readOnly, search]);

  function toggleMember(user, checked) {
    setMembers((current) => {
      const id = String(user.id);
      if (checked) return current.some((m) => String(m.id) === id) ? current : [...current, user];
      return current.filter((m) => String(m.id) !== id);
    });
  }

  async function handleSave() {
    if (!name.trim()) {
      notify({ title: "Validation error", description: "Name is required", variant: "error" });
      return;
    }
    setSaving(true);
    try {
      const payload = { name: name.trim(), description: description.trim(), isActive, memberIds: members.map((m) => String(m.id)) };
      const url = teamId ? `/api/admin/teams/${encodeURIComponent(teamId)}` : "/api/admin/teams";
      const res = await fetch(url, { method: teamId ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save team");
      }
      notify({ title: "Team saved", description: `Team ${teamId ? "updated" : "created"} successfully`, variant: "success" });
      onSave?.();
      onOpenChange(false);
    } catch (error) {
      notify({ title: "Failed to save team", description: error.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const visibleCandidates = candidates.filter((user) => !memberIds.has(String(user.id)));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent ref={registerHelpPortalContainer} side="right" data-context-help-host="true" className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0">
        <SheetHeader className="px-6 py-4 pr-12 border-b">
          <div className="flex items-center justify-between gap-3">
            <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
              {teamId ? (<><IconEdit className="size-5" />{readOnly ? "Team" : "Edit Team"}</>) : (<><IconPlus className="size-5" />Create Team</>)}
            </SheetTitle>
            <Button type="button" variant="ghost" size="sm" aria-controls="context-help-sheet" aria-keyshortcuts="F1" title="Help for teams (F1)" onMouseDown={(event) => event.preventDefault()} onClick={() => openHelp()}>
              <IconHelpCircle aria-hidden="true" />
              Help
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4">
            <CardContent className="p-6 space-y-4">
              {loading ? (
                <div className="space-y-3">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between pb-4 border-b">
                    <Label htmlFor="team-active" className="text-sm font-medium">Active</Label>
                    <Switch id="team-active" checked={isActive} onCheckedChange={setIsActive} disabled={readOnly} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="team-name">Name *</Label>
                    <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Warsaw Sales, Night Shift" disabled={readOnly} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="team-description">Description</Label>
                    <Input id="team-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description for this team" disabled={readOnly} />
                  </div>

                  <div className="space-y-2 pt-2 border-t">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Members</Label>
                      <Badge variant="secondary">{members.length}</Badge>
                    </div>
                    <div className="rounded-md border divide-y max-h-48 overflow-y-auto" data-testid="team-members">
                      {members.length === 0 ? (
                        <div className="px-3 py-3 text-xs text-muted-foreground">No members yet.</div>
                      ) : members.map((member) => (
                        <label key={member.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                          <Checkbox checked onCheckedChange={(checked) => toggleMember(member, Boolean(checked))} disabled={readOnly} />
                          <span className="truncate">{memberLabel(member)}</span>
                        </label>
                      ))}
                    </div>
                    {readOnly ? null : (
                      <>
                        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search users to add…" aria-label="Search users" />
                        <div className="rounded-md border divide-y max-h-56 overflow-y-auto">
                          {searching && visibleCandidates.length === 0 ? (
                            <div className="px-3 py-3 text-xs text-muted-foreground">Searching…</div>
                          ) : visibleCandidates.length === 0 ? (
                            <div className="px-3 py-3 text-xs text-muted-foreground">No more users match.</div>
                          ) : visibleCandidates.map((user) => (
                            <label key={user.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                              <Checkbox checked={false} onCheckedChange={(checked) => toggleMember(user, Boolean(checked))} />
                              <span className="truncate">{memberLabel(user)}</span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{readOnly ? "Close" : "Cancel"}</Button>
          {readOnly ? null : (
            <Button onClick={handleSave} disabled={saving || !name.trim()}>{saving ? "Saving..." : "Save Changes"}</Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
