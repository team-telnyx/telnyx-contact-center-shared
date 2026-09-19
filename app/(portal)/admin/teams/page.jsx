"use client";

import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { ConfigurationSectionPage } from "@/components/admin/ConfigurationSectionNav";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight, IconEdit, IconTrash } from "@tabler/icons-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { notify } from "@/components/ToastNotify";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAuth } from "@/components/auth-provider";
import TeamEditSheet from "@/components/teams/EditSheet";

/**
 * Admin → Configuration → Teams. Teams group agents for supervision and for
 * the `teams` scope anchor of roles (Phase 3a of the RBAC plan).
 */
export default function AdminTeamsPage() {
  const { can } = useAuth();
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ active: "all", q: "" });
  const [loading, setLoading] = useState(false);
  const [editTeamId, setEditTeamId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.active && filters.active !== "all") sp.set("active", filters.active);
    if (filters.q) sp.set("q", filters.q);
    return sp.toString();
  }, [page, pageSize, filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/teams?${query}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch teams");
      setItems(data.items || []);
      setTotal(Number(data.total || 0));
    } catch (err) {
      notify({ title: "Load failed", description: String(err.message || err), variant: "error" });
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  async function onDelete(id) {
    if (!id) return;
    const r = await fetch(`/api/admin/teams/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      notify({
        title: "Team deleted",
        description: `${d.removedFromUsers || 0} member${d.removedFromUsers === 1 ? "" : "s"} unassigned${d.rolesUpdated ? `, ${d.rolesUpdated} role scope${d.rolesUpdated === 1 ? "" : "s"} updated` : ""}.`,
        variant: "success",
      });
      load();
    } else {
      const d = await r.json().catch(() => ({}));
      notify({ title: "Delete failed", description: d?.error || "", variant: "error" });
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const canCreate = can("teams:create");
  const canUpdate = can(["teams:update", "teams:members.assign"]);
  const canDelete = can("teams:delete");

  const headerActions = (
    <>
      <Button variant="secondary" onClick={() => setFilters({ active: "all", q: "" })}>Clear</Button>
      <Button onClick={() => load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Button>
      {canCreate ? (
        <Button onClick={() => { setEditTeamId(null); setShowEditSheet(true); }} variant="default">New Team</Button>
      ) : null}
    </>
  );

  return (
    <AdminPageShell>
      <AdminPageHeader title="Teams" badges={<Badge variant="secondary">{total} teams</Badge>} actions={headerActions} />
      <ConfigurationSectionPage activeId="teams">
        <div className="space-y-4">
          <Card className="w-full">
            <CardContent className="space-y-4 pt-6">
              <div className="grid grid-cols-6 gap-2 items-end">
                <div>
                  <label className="text-xs">Name</label>
                  <Input value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder="name, description…" />
                </div>
                <div>
                  <label className="text-xs">Active</label>
                  <Select value={filters.active || "all"} onValueChange={(value) => setFilters((f) => ({ ...f, active: value }))}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="All" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="true">Yes</SelectItem>
                      <SelectItem value="false">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {loading ? (
                <div className="border rounded-md overflow-hidden p-4 space-y-2">
                  <Skeleton className="h-6 w-40" />
                  {[...Array(6)].map((_, i) => (<Skeleton key={i} className="h-10 w-full" />))}
                </div>
              ) : (
                <div className="border rounded-md overflow-hidden">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="px-[10px]">Name</TableHead>
                        <TableHead className="px-[10px] w-28">Members</TableHead>
                        <TableHead className="px-[10px] w-24">Active</TableHead>
                        <TableHead className="px-[10px]">Description</TableHead>
                        <TableHead className="px-[10px] text-right w-28">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((team) => (
                        <TableRow key={team.id} data-testid="team-row">
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">{team.name}</TableCell>
                          <TableCell className="px-[10px] text-xs">{team.membersCount ?? 0}</TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge variant="outline" className={team.isActive ? "border-green-500 text-green-600 min-w-[56px] justify-center" : "border-red-500 text-red-600 min-w-[56px] justify-center"}>
                              {team.isActive ? "YES" : "NO"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs max-w-md truncate">{team.description || "—"}</TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => { setEditTeamId(team.id); setShowEditSheet(true); }}
                                className="inline-flex items-center text-telnyx-green"
                                title={canUpdate ? "Edit team" : "View team"}
                              >
                                <IconEdit className="size-4" />
                              </button>
                              {canDelete ? (
                                <Dialog>
                                  <DialogTrigger asChild>
                                    <button type="button" className="inline-flex items-center text-red-500" title="Delete team">
                                      <IconTrash className="size-4" />
                                    </button>
                                  </DialogTrigger>
                                  <DialogContent>
                                    <DialogHeader>
                                      <DialogTitle>Delete team?</DialogTitle>
                                      <DialogDescription>
                                        Members are unassigned and the team is removed from every role scope that lists it. This action cannot be undone. Delete the team &quot;{team.name}&quot;?
                                      </DialogDescription>
                                    </DialogHeader>
                                    <div className="flex justify-end gap-2 pt-2">
                                      <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                                      <DialogClose asChild><Button variant="destructive" onClick={() => onDelete(team.id)}>Delete</Button></DialogClose>
                                    </div>
                                  </DialogContent>
                                </Dialog>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                      {items.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center py-8 text-sm text-muted-foreground">
                            No teams yet. Create one to group agents for supervision and for the Teams scope of roles.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
            <div className="px-6 pb-6">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">Total: {total}</div>
                <div className="flex w-full items-center gap-8 lg:w-fit">
                  <div className="hidden items-center gap-2 lg:flex">
                    <Label htmlFor="rows-per-page" className="text-sm font-medium">Rows per page</Label>
                    <Select value={`${pageSize}`} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}>
                      <SelectTrigger id="rows-per-page" className="w-[70px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="25">25</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPage(1)} disabled={page === 1}><IconChevronsLeft className="h-4 w-4" /></Button>
                    <Button variant="outline" size="sm" onClick={() => setPage(page - 1)} disabled={page === 1}><IconChevronLeft className="h-4 w-4" /></Button>
                    <span className="text-sm">Page {page} of {pageCount}</span>
                    <Button variant="outline" size="sm" onClick={() => setPage(page + 1)} disabled={page >= pageCount}><IconChevronRight className="h-4 w-4" /></Button>
                    <Button variant="outline" size="sm" onClick={() => setPage(pageCount)} disabled={page >= pageCount}><IconChevronsRight className="h-4 w-4" /></Button>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <TeamEditSheet open={showEditSheet} onOpenChange={setShowEditSheet} teamId={editTeamId} onSave={load} readOnly={!canUpdate && Boolean(editTeamId)} />
        </div>
      </ConfigurationSectionPage>
    </AdminPageShell>
  );
}
