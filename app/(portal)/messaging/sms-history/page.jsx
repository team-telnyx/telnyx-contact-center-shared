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
  IconArrowDownLeft,
  IconArrowUpRight,
  IconCornerDownLeft,
  IconHistory,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "@tabler/icons-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { useRouter } from "next/navigation";

export default function MessagingSmsHistoryView() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [filters, setFilters] = useState({
    to: "",
    from: "",
    direction: "",
    status: "",
    q: "",
  });
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    Object.entries(filters).forEach(([k, v]) => v && sp.set(k, v));
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/messaging/history?${query}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch history");
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      toast.error("Load failed", {
        description: String(err.message || err),
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [query]);

  function formatDateTime(input) {
    const d = new Date(input);
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = d.getFullYear();
    const MM = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const HH = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
  }

  function statusClasses(status) {
    switch ((status || "").toLowerCase()) {
      case "queued":
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200 border-transparent";
      case "sending":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-transparent";
      case "sent":
        return "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 border-transparent";
      case "delivered":
        return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-transparent";
      case "undeliverable":
        return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-transparent";
      case "failed":
        return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-transparent";
      case "finalized":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-transparent";
      case "timeout":
        return "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 border-transparent";
      default:
        return "bg-muted text-foreground border-transparent";
    }
  }

  function capitalizeStatus(value) {
    if (!value) return "";
    return String(value).toUpperCase();
  }

  function goToSend(toNumber) {
    const to = String(toNumber || "");
    router.push(`/messaging/send-sms?to=${encodeURIComponent(to)}`);
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconHistory className="size-6 text-primary" /> SMS History
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  setFilters({
                    to: "",
                    from: "",
                    direction: "",
                    status: "",
                    q: "",
                  })
                }
              >
                Clear
              </Button>
              <Button onClick={() => load()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
            <div>
              <label className="text-xs">To</label>
              <Input
                value={filters.to}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, to: e.target.value }))
                }
                placeholder="+1415…"
              />
            </div>
            <div>
              <label className="text-xs">From</label>
              <Input
                value={filters.from}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, from: e.target.value }))
                }
                placeholder="+1415…"
              />
            </div>
            <div>
              <label className="text-xs">Direction</label>
              <Select
                value={filters.direction || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({
                    ...f,
                    direction: value === "all" ? "" : value,
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="inbound">Inbound</SelectItem>
                  <SelectItem value="outbound">Outbound</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs">Status</label>
              <Select
                value={filters.status || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({
                    ...f,
                    status: value === "all" ? "" : value,
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="queued">queued</SelectItem>
                  <SelectItem value="sending">sending</SelectItem>
                  <SelectItem value="sent">sent</SelectItem>
                  <SelectItem value="delivered">delivered</SelectItem>
                  <SelectItem value="undeliverable">undeliverable</SelectItem>
                  <SelectItem value="failed">failed</SelectItem>
                  <SelectItem value="finalized">finalized</SelectItem>
                  <SelectItem value="timeout">timeout</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <label className="text-xs">Search</label>
              <Input
                value={filters.q}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, q: e.target.value }))
                }
                placeholder="text contains…"
              />
            </div>
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
                    <TableHead className="px-[10px]">Direction</TableHead>
                    <TableHead className="px-[10px]">From</TableHead>
                    <TableHead className="px-[10px]">To</TableHead>
                    <TableHead className="px-[10px] w-[50%]">Body</TableHead>
                    <TableHead className="px-[10px]">Status</TableHead>
                    <TableHead className="px-[10px]">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((m) => {
                    const rowId =
                      m.id || m._id || `${m.to}-${m.from}-${m.createdAt}`;
                    return (
                      <Fragment key={rowId}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() =>
                            setExpandedId((id) => (id === rowId ? null : rowId))
                          }
                        >
                          <TableCell className="px-[10px] text-xs">
                            <span className="flex items-center gap-1 uppercase">
                              {m.direction === "inbound" ? (
                                <IconArrowDownLeft className="size-4 text-emerald-600" />
                              ) : (
                                <IconArrowUpRight className="size-4 text-blue-600" />
                              )}
                              <span>{m.direction}</span>
                            </span>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {m.from}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {m.to}
                          </TableCell>
                          <TableCell
                            className="px-[10px] text-xs"
                            title={m.body}
                          >
                            <div className="truncate">{m.body}</div>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              className={
                                statusClasses(m.status) + " justify-center"
                              }
                              style={{ width: "100px" }}
                              variant="outline"
                            >
                              {capitalizeStatus(m.status)}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {formatDateTime(m.createdAt)}
                          </TableCell>
                        </TableRow>
                        {expandedId === rowId && (
                          <TableRow>
                            <TableCell colSpan={6} className="bg-muted/30 p-0">
                              <Card className="m-2">
                                <CardContent className="py-4">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="text-sm whitespace-pre-wrap break-words flex-1">
                                      {m.body || "<empty>"}
                                    </div>
                                    {m.direction === "inbound" && (
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        title="Reply"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          goToSend(m.from);
                                        }}
                                      >
                                        <IconCornerDownLeft className="size-8 text-primary" />
                                      </Button>
                                    )}
                                  </div>
                                </CardContent>
                              </Card>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                  {items.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center py-8 text-sm text-muted-foreground"
                      >
                        No messages
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
    </div>
  );
}
