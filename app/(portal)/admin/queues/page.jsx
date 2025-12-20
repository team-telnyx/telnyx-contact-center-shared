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
  IconList,
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
import EditSheet from "@/components/queues/EditSheet";

export default function AdminQueuesPage() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    routingStrategy: "all",
    q: "",
  });
  const [loading, setLoading] = useState(false);
  const [editQueueId, setEditQueueId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);

  function handleNewQueue() {
    setEditQueueId(null);
    setShowEditSheet(true);
  }

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.routingStrategy && filters.routingStrategy !== "all")
      sp.set("routingStrategy", filters.routingStrategy);
    if (filters.q) sp.set("q", filters.q);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/queues?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch queues");
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

  async function onDelete(id) {
    if (!id) return;
    const r = await fetch(`/api/admin/queues/${encodeURIComponent(id)}`, {
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

  function routingStrategyBadgeColor(strategy) {
    switch (String(strategy || "FIFO")) {
      case "FIFO":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
      case "Skill-based":
        return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
      case "Priority-based":
        return "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300";
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
              <IconList className="size-6 text-telnyx-green" /> Queues
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => setFilters({ routingStrategy: "all", q: "" })}
              >
                Clear
              </Button>
              <Button onClick={() => load()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
              <Button onClick={handleNewQueue} variant="default">
                New Queue
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-2 items-end">
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
              <label className="text-xs">Routing</label>
              <Select
                value={filters.routingStrategy || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, routingStrategy: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="FIFO">FIFO</SelectItem>
                  <SelectItem value="Skill-based">Skill-based</SelectItem>
                  <SelectItem value="Priority-based">Priority-based</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div></div>
            <div></div>
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
                    <TableHead className="px-[10px]">Routing</TableHead>
                    <TableHead className="px-[10px]">Max Wait</TableHead>
                    <TableHead className="px-[10px]">Max Size</TableHead>
                    <TableHead className="px-[10px]">Priority</TableHead>
                    <TableHead className="px-[10px]">Enabled</TableHead>
                    <TableHead className="px-[10px] text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((q) => {
                    const rowId = q.id;
                    return (
                      <Fragment key={rowId}>
                        <TableRow>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {q.name}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              className={
                                routingStrategyBadgeColor(q.routing_strategy) +
                                " justify-center"
                              }
                              style={{ width: "120px" }}
                              variant="outline"
                            >
                              {q.routing_strategy || "FIFO"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {q.max_wait_time_secs || 0}s
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {q.max_size || 0}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {q.priority || 0}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {q.enabled ? "YES" : "NO"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditQueueId(q.id);
                                  setShowEditSheet(true);
                                }}
                                className="inline-flex items-center text-telnyx-green"
                                title="Edit queue"
                              >
                                <IconEdit className="size-4" />
                              </button>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    type="button"
                                    className="inline-flex items-center text-red-500"
                                    title="Delete queue"
                                  >
                                    <IconTrash className="size-4" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Delete queue?</DialogTitle>
                                    <DialogDescription>
                                      This action cannot be undone. This will
                                      permanently delete the queue "{q.name}".
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="flex justify-end gap-2 pt-2">
                                    <DialogClose asChild>
                                      <Button variant="outline">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() => onDelete(q.id)}
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
                        colSpan={7}
                        className="text-center py-8 text-sm text-muted-foreground"
                      >
                        No queues
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

      {/* Edit Sheet */}
      <EditSheet
        open={showEditSheet}
        onOpenChange={setShowEditSheet}
        queueId={editQueueId}
        onSaveComplete={load}
      />
    </div>
  );
}
