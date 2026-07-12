"use client";

import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { ConfigurationSectionPage } from "@/components/admin/ConfigurationSectionNav";
import { Fragment, useEffect, useMemo, useState } from "react";
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
  IconEdit,
  IconTrash,
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
import EditSheet from "@/components/skills/EditSheet";

export default function AdminSkillsPage() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    active: "all",
    category: "all",
    q: "",
  });
  const [loading, setLoading] = useState(false);
  const [editSkillId, setEditSkillId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);

  function handleNewSkill() {
    setEditSkillId(null);
    setShowEditSheet(true);
  }

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.active && filters.active !== "all")
      sp.set("active", filters.active);
    if (filters.category && filters.category !== "all")
      sp.set("category", filters.category);
    if (filters.q) sp.set("q", filters.q);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/skills?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch skills");
      setItems(data.items || []);
      setTotal(Number(data.total || 0));
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

  async function onDelete(id) {
    if (!id) return;
    const r = await fetch(`/api/admin/skills/${encodeURIComponent(id)}`, {
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

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Extract unique categories from current items
  const availableCategories = useMemo(() => {
    const categorySet = new Set();
    items.forEach((item) => {
      if (item.category) categorySet.add(item.category);
    });
    return Array.from(categorySet).sort();
  }, [items]);

  const headerActions = <>
    <Button
      variant="secondary"
      onClick={() =>
        setFilters({
          active: "all",
          category: "all",
          q: "",
        })
      }
    >
      Clear
    </Button>
    <Button onClick={() => load()} disabled={loading}>
      {loading ? "Loading…" : "Refresh"}
    </Button>
    <Button onClick={handleNewSkill} variant="default">
      New Skill
    </Button>
  </>;

  return (
    <AdminPageShell>
      <AdminPageHeader title="Skills" badges={<Badge variant="secondary">{total} skills</Badge>} actions={headerActions} />
      <ConfigurationSectionPage activeId="skills">
        <div className="space-y-4">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="grid grid-cols-6 gap-2 items-end">
            <div>
              <label className="text-xs">Name</label>
              <Input
                value={filters.q}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, q: e.target.value }))
                }
                placeholder="name, description…"
              />
            </div>
            <div>
              <label className="text-xs">Category</label>
              <Select
                value={filters.category || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, category: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {availableCategories.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs">Active</label>
              <Select
                value={filters.active || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, active: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="true">Yes</SelectItem>
                  <SelectItem value="false">No</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div></div>
            <div></div>
            <div></div>
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
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-[10px]">Name</TableHead>
                    <TableHead className="px-[10px]">Category</TableHead>
                    <TableHead className="px-[10px]">Active</TableHead>
                    <TableHead className="px-[10px]">Description</TableHead>
                    <TableHead className="px-[10px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((skill) => {
                    const rowId = skill.id;
                    return (
                      <Fragment key={rowId}>
                        <TableRow>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {skill.name}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {skill.category || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              variant="outline"
                              className={
                                skill.is_active
                                  ? "border-green-500 text-green-600 min-w-[56px] justify-center"
                                  : "border-red-500 text-red-600 min-w-[56px] justify-center"
                              }
                            >
                              {skill.is_active ? "YES" : "NO"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs max-w-md truncate">
                            {skill.description || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditSkillId(skill.id);
                                  setShowEditSheet(true);
                                }}
                                className="inline-flex items-center text-telnyx-green"
                                title="Edit skill"
                              >
                                <IconEdit className="size-4" />
                              </button>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    type="button"
                                    className="inline-flex items-center text-red-500"
                                    title="Delete skill"
                                  >
                                    <IconTrash className="size-4" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Delete skill?</DialogTitle>
                                    <DialogDescription>
                                      This action cannot be undone. This will
                                      permanently delete the skill "
                                      {skill.name}".
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="flex justify-end gap-2 pt-2">
                                    <DialogClose asChild>
                                      <Button variant="outline">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() => onDelete(skill.id)}
                                      >
                                        Delete
                                      </Button>
                                    </DialogClose>
                                  </div>
                                </DialogContent>
                              </Dialog>
                            </div>
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    );
                  })}
                  {items.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-sm text-muted-foreground"
                      >
                        No skills
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
                  <SelectTrigger id="rows-per-page" className="w-[70px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="25">25</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(1)}
                  disabled={page === 1}
                >
                  <IconChevronsLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                >
                  <IconChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm">
                  Page {page} of {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(page + 1)}
                  disabled={page >= pageCount}
                >
                  <IconChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(pageCount)}
                  disabled={page >= pageCount}
                >
                  <IconChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <EditSheet
        open={showEditSheet}
        onOpenChange={setShowEditSheet}
        skillId={editSkillId}
        onSave={load}
      />
        </div>
      </ConfigurationSectionPage>
    </AdminPageShell>
  );
}
