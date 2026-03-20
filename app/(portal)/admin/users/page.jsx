"use client";

import React, { Fragment, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconUsers,
  IconEdit,
  IconTrash,
  IconInfoCircle,
  IconStar,
  IconStarFilled,
  IconUserPlus,
} from "@tabler/icons-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { notify } from "@/components/ToastNotify";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import EditSheet from "@/components/users/EditSheet";

function SkillsInfoCell({ user }) {
  const skills = user.skills || {};
  let skillsObj = {};
  try {
    if (typeof skills === 'string') {
      skillsObj = skills ? JSON.parse(skills) : {};
    } else if (skills && typeof skills === 'object') {
      skillsObj = skills;
    }
  } catch (e) {
    console.error("Failed to parse skills:", e);
    skillsObj = {};
  }
  const skillCount = Object.keys(skillsObj).length;
  const [allSkills, setAllSkills] = React.useState([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    async function loadSkills() {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/skills?active=true&pageSize=1000", {
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          setAllSkills(data.items || []);
        }
      } catch (err) {
        console.error("Failed to load skills:", err);
      } finally {
        setLoading(false);
      }
    }
    loadSkills();
  }, []);

  const skillEntries = Object.entries(skillsObj).map(([skillId, proficiency]) => {
    const skill = allSkills.find(s => s.id === skillId);
    return { skill, proficiency };
  }).filter(entry => entry.skill);

  return (
    <div className="flex items-center gap-1">
      <span className="text-xs">{skillCount}</span>
      {skillCount > 0 && (
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center text-muted-foreground hover:text-foreground"
              title="View skills"
            >
              <IconInfoCircle className="size-3" />
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>User Skills</DialogTitle>
              <DialogDescription>
                Skills assigned to {user.first_name} {user.last_name || user.username}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 mt-4">
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : skillEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground">No skills assigned</p>
              ) : (
                skillEntries.map(({ skill, proficiency }) => (
                  <div
                    key={skill.id}
                    className="flex items-center justify-between p-2 border rounded"
                  >
                    <div>
                      <div className="text-sm font-medium">{skill.name}</div>
                      {skill.description && (
                        <div className="text-xs text-muted-foreground">
                          {skill.description}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 ml-4">
                      {[1, 2, 3, 4, 5].map((level) => (
                        proficiency >= level ? (
                          <IconStarFilled
                            key={level}
                            className="size-4 text-yellow-500"
                          />
                        ) : (
                          <IconStar
                            key={level}
                            className="size-4 text-gray-300"
                          />
                        )
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}


export default function AdminUsersPage() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    role: "all",
    q: "",
  });
  const [loading, setLoading] = useState(false);
  const [editUserId, setEditUserId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);
  const [addUserOpen, setAddUserOpen] = useState(false);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.role && filters.role !== "all") sp.set("role", filters.role);
    if (filters.q) sp.set("q", filters.q);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch users");
      setItems(data.rows || []);
      setTotal(Number(data.count || 0));
    } catch (err) {
      notify({
        title: "Load failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [query]);

  async function onDelete(id, roles) {
    if (!id) return;
    // Check if user has owner role (support both roles array and legacy role field)
    const userRoles = Array.isArray(roles) ? roles : roles ? [roles] : [];
    const hasOwnerRole = userRoles
      .map((r) => String(r).toLowerCase())
      .includes("owner");
    if (hasOwnerRole) {
      notify({
        title: "Not allowed",
        description: "Owner accounts cannot be deleted.",
        variant: "warning",
      });
      return;
    }
    const r = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (r.ok) load();
    else {
      const d = await r.json().catch(() => ({}));
      notify({
        title: "Delete failed",
        description: d?.error || "",
        variant: "error",
      });
    }
  }

  function roleBadgeColor(role) {
    switch (String(role || "user").toLowerCase()) {
      case "owner":
        return "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300";
      case "admin":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
      case "supervisor":
        return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
      default:
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Extract unique roles from current items
  const availableRoles = useMemo(() => {
    const roleSet = new Set();
    items.forEach((u) => {
      const userRoles =
        u.roles && Array.isArray(u.roles) && u.roles.length > 0
          ? u.roles
          : ["user"];
      userRoles.forEach((r) => roleSet.add(String(r).toLowerCase()));
    });
    return Array.from(roleSet).sort();
  }, [items]);

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconUsers className="size-6 text-telnyx-green" /> Users
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="gap-2" onClick={() => setAddUserOpen(true)}>
                <IconUserPlus className="size-4" />
                Add User
              </Button>
              <Button
                variant="secondary"
                onClick={() => setFilters({ role: "all", q: "" })}
              >
                Clear
              </Button>
              <Button onClick={() => load()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
            </div>
          </div>
          <div className="flex gap-2 items-end">
            <div style={{ width: "20%", minWidth: 0 }}>
              <label className="text-xs">Name</label>
              <Input
                value={filters.q}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, q: e.target.value }))
                }
                placeholder="name, username, mobile…"
                className="w-full"
              />
            </div>
            <div style={{ width: "30%", minWidth: 0 }}>
              <label className="text-xs">Role</label>
              <Select
                value={filters.role || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, role: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {availableRoles.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div style={{ width: "15%" }}></div>
            <div style={{ width: "10%" }}></div>
            <div style={{ width: "10%" }}></div>
            <div style={{ width: "15%" }}></div>
          </div>

          {loading ? (
            <div className="border rounded-md overflow-hidden p-4 space-y-2">
              <Skeleton className="h-6 w-40" />
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <Table className="table-fixed">
                <colgroup>
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "30%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "10%" }} />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-[10px]">Name</TableHead>
                    <TableHead className="px-[10px]">Username</TableHead>
                    <TableHead className="px-[10px]">Roles</TableHead>
                    <TableHead className="px-[10px]">Skills</TableHead>
                    <TableHead className="px-[10px]">Verified</TableHead>
                    <TableHead className="px-[10px] text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((u) => {
                    const rowId = u.id;
                    const fullName = [u.first_name, u.last_name]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <Fragment key={rowId}>
                        <TableRow>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {fullName || u.nick || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {u.username}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <div className="flex flex-wrap gap-1">
                              {(u.roles &&
                              Array.isArray(u.roles) &&
                              u.roles.length > 0
                                ? u.roles
                                : u.role
                                ? [u.role]
                                : ["user"]
                              ).map((r) => (
                                <Badge
                                  key={r}
                                  className={
                                    roleBadgeColor(r) + " justify-center"
                                  }
                                  variant="outline"
                                >
                                  {String(r || "user").toUpperCase()}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <SkillsInfoCell user={u} />
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              variant="outline"
                              className={
                                u.verified
                                  ? "border-green-500 text-green-600 bg-green-50 dark:bg-green-900/20 dark:text-green-400 min-w-[56px] justify-center"
                                  : "border-red-500 text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 min-w-[56px] justify-center"
                              }
                            >
                              {u.verified ? "YES" : "NO"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditUserId(u.id);
                                  setShowEditSheet(true);
                                }}
                                className="inline-flex items-center text-telnyx-green"
                                title="Edit user"
                              >
                                <IconEdit className="size-4" />
                              </button>
                              {!(
                                (u.roles &&
                                  Array.isArray(u.roles) &&
                                  u.roles
                                    .map((r) => String(r).toLowerCase())
                                    .includes("owner")) ||
                                String(u.role || "").toLowerCase() === "owner"
                              ) ? (
                                <Dialog>
                                  <DialogTrigger asChild>
                                    <button
                                      type="button"
                                      className="inline-flex items-center text-red-500"
                                      title="Delete user"
                                    >
                                      <IconTrash className="size-4" />
                                    </button>
                                  </DialogTrigger>
                                  <DialogContent>
                                    <DialogHeader>
                                      <DialogTitle>Delete user?</DialogTitle>
                                      <DialogDescription>
                                        This action cannot be undone. This will
                                        permanently delete the user "
                                        {u.username}".
                                      </DialogDescription>
                                    </DialogHeader>
                                    <div className="flex justify-end gap-2 pt-2">
                                      <DialogClose asChild>
                                        <Button variant="outline">
                                          Cancel
                                        </Button>
                                      </DialogClose>
                                      <DialogClose asChild>
                                        <Button
                                          variant="destructive"
                                          onClick={() =>
                                            onDelete(u.id, u.roles || u.role)
                                          }
                                        >
                                          Delete
                                        </Button>
                                      </DialogClose>
                                    </div>
                                  </DialogContent>
                                </Dialog>
                              ) : (
                                <button
                                  type="button"
                                  disabled
                                  className="inline-flex items-center text-gray-400 opacity-50 cursor-not-allowed"
                                  title="Owner cannot be deleted"
                                >
                                  <IconTrash className="size-4" />
                                </button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    );
                  })}
                  {items.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center py-8 text-sm text-muted-foreground"
                      >
                        No users
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
                <Label htmlFor="rows-per-page" className="text-sm font-medium">
                  Rows per page
                </Label>
                <Select
                  value={`${pageSize}`}
                  onValueChange={(value) => {
                    setPageSize(Number(value));
                    setPage(1);
                  }}
                >
                  <SelectTrigger size="sm" className="w-20" id="rows-per-page">
                    <SelectValue placeholder={pageSize} />
                  </SelectTrigger>
                  <SelectContent side="top">
                    {[10, 20, 30, 40, 50].map((size) => (
                      <SelectItem key={size} value={`${size}`}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-fit items-center justify-center text-sm font-medium">
                Page {page} of {pageCount}
              </div>
              <div className="ml-auto flex items-center gap-2 lg:ml-0">
                <Button
                  variant="outline"
                  className="hidden h-8 w-8 p-0 lg:flex"
                  onClick={() => setPage(1)}
                  disabled={page <= 1}
                >
                  <span className="sr-only">Go to first page</span>
                  <IconChevronsLeft />
                </Button>
                <Button
                  variant="outline"
                  className="size-8"
                  size="icon"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <span className="sr-only">Go to previous page</span>
                  <IconChevronLeft />
                </Button>
                <Button
                  variant="outline"
                  className="size-8"
                  size="icon"
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  disabled={page >= pageCount}
                >
                  <span className="sr-only">Go to next page</span>
                  <IconChevronRight />
                </Button>
                <Button
                  variant="outline"
                  className="hidden size-8 lg:flex"
                  size="icon"
                  onClick={() => setPage(pageCount)}
                  disabled={page >= pageCount}
                >
                  <span className="sr-only">Go to last page</span>
                  <IconChevronsRight />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Add User Sheet (create mode) */}
      <EditSheet
        userId={null}
        createMode={true}
        open={addUserOpen}
        onOpenChange={setAddUserOpen}
        onSaved={() => { setAddUserOpen(false); load(); }}
      />

      {/* Edit Sheet */}
      <EditSheet
        open={showEditSheet}
        onOpenChange={setShowEditSheet}
        userId={editUserId}
        onSaveComplete={load}
      />
    </div>
  );
}
