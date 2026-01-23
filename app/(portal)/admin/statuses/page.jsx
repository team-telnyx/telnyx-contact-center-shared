"use client";

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
  IconTag,
  IconEdit,
  IconTrash,
  IconPlus,
} from "@tabler/icons-react";
import {
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
  DEFAULT_STATUS_ICON,
} from "@/config/status-icons";
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
import EditSheet from "@/components/statuses/EditSheet";

export default function AdminStatusesPage() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    type: "all",
    active: "all",
    userSelectable: "all",
    q: "",
  });
  const [loading, setLoading] = useState(false);
  const [editStatusId, setEditStatusId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);

  function handleNewStatus() {
    setEditStatusId(null);
    setShowEditSheet(true);
  }

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.type && filters.type !== "all") sp.set("type", filters.type);
    if (filters.active && filters.active !== "all")
      sp.set("active", filters.active);
    if (filters.userSelectable && filters.userSelectable !== "all")
      sp.set("userSelectable", filters.userSelectable);
    if (filters.q) sp.set("q", filters.q);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/statuses?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch statuses");
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
    const r = await fetch(`/api/admin/statuses/${encodeURIComponent(id)}`, {
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

  function typeBadgeColor(type) {
    switch (String(type || "active").toLowerCase()) {
      case "active":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
      case "break":
        return "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300";
      default:
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconTag className="size-6 text-telnyx-green" /> User Statuses
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  setFilters({
                    type: "all",
                    active: "all",
                    userSelectable: "all",
                    q: "",
                  })
                }
              >
                Clear
              </Button>
              <Button onClick={() => load()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
              <Button onClick={handleNewStatus} variant="default">
                New Status
              </Button>
            </div>
          </div>
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
              <label className="text-xs">Type</label>
              <Select
                value={filters.type || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, type: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="break">Break</SelectItem>
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
            <div>
              <label className="text-xs">User selectable</label>
              <Select
                value={filters.userSelectable || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, userSelectable: value }))
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
                    <TableHead className="px-[10px]">Type</TableHead>
                    <TableHead className="px-[10px]">Active</TableHead>
                    <TableHead className="px-[10px]">User Selectable</TableHead>
                    <TableHead className="px-[10px]">Icon</TableHead>
                    <TableHead className="px-[10px]">Display Order</TableHead>
                    <TableHead className="px-[10px]">Description</TableHead>
                    <TableHead className="px-[10px] text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((status) => {
                    const rowId = status.id;
                    return (
                      <Fragment key={rowId}>
                        <TableRow>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {status.name}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              className={
                                typeBadgeColor(status.type) + " justify-center"
                              }
                              variant="outline"
                            >
                              {status.type === "active" ? "Active" : "Break"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              variant="outline"
                              className={
                                status.is_active
                                  ? "border-green-500 text-green-600 min-w-[56px] justify-center"
                                  : "border-red-500 text-red-600 min-w-[56px] justify-center"
                              }
                            >
                              {status.is_active ? "YES" : "NO"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              variant="outline"
                              className={
                                status.user_selectable
                                  ? "border-green-500 text-green-600 min-w-[56px] justify-center"
                                  : "border-red-500 text-red-600 min-w-[56px] justify-center"
                              }
                            >
                              {status.user_selectable ? "YES" : "NO"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {(() => {
                              const Icon =
                                STATUS_ICON_MAP[status.icon] ||
                                STATUS_NAME_ICON_FALLBACK[status.name] ||
                                STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                              return (
                                <div className="inline-flex items-center gap-2">
                                  <Icon
                                    className="size-4"
                                    style={
                                      status.color
                                        ? { color: status.color }
                                        : undefined
                                    }
                                  />
                                  <span className="text-muted-foreground">
                                    {status.icon || "—"}
                                  </span>
                                </div>
                              );
                            })()}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {status.display_order || 0}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs max-w-md truncate">
                            {status.description || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditStatusId(status.id);
                                  setShowEditSheet(true);
                                }}
                                className="inline-flex items-center text-telnyx-green"
                                title="Edit status"
                              >
                                <IconEdit className="size-4" />
                              </button>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    type="button"
                                    className="inline-flex items-center text-red-500"
                                    title="Delete status"
                                  >
                                    <IconTrash className="size-4" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Delete status?</DialogTitle>
                                    <DialogDescription>
                                      This action cannot be undone. This will
                                      permanently delete the status "
                                      {status.name}".
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="flex justify-end gap-2 pt-2">
                                    <DialogClose asChild>
                                      <Button variant="outline">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() => onDelete(status.id)}
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
                        colSpan={8}
                        className="text-center py-8 text-sm text-muted-foreground"
                      >
                        No statuses
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
        statusId={editStatusId}
        onSave={load}
      />
    </div>
  );
}
