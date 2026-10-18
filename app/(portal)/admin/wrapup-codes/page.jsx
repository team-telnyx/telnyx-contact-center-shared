"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


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
import EditSheet from "@/components/wrapup-codes/EditSheet";
import { Can } from "@/components/auth-provider";

export default function AdminWrapupCodesPage() {
  const tUi = useUiText();
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    active: "all",
    q: "",
  });
  const [loading, setLoading] = useState(false);
  const [editWrapupCodeId, setEditWrapupCodeId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);

  function handleNewWrapupCode() {
    setEditWrapupCodeId(null);
    setShowEditSheet(true);
  }

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.active && filters.active !== "all")
      sp.set("active", filters.active);
    if (filters.q) sp.set("q", filters.q);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/wrapup-codes?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch wrapup codes");
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
    const r = await fetch(`/api/admin/wrapup-codes/${encodeURIComponent(id)}`, {
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

  const headerActions = <>
    <Button
      variant="secondary"
      onClick={() =>
        setFilters({
          active: "all",
          q: "",
        })
      }
    >{tUi("Clear")}</Button>
    <Button onClick={() => load()} disabled={loading}>
      {loading ? tUi("Loading…") : tUi("Refresh")}
    </Button>
    <Can permission="wrapup_codes:create"><Button onClick={handleNewWrapupCode} variant="default">{tUi("New Wrapup Code")}</Button></Can>
  </>;

  return (
    <AdminPageShell>
      <AdminPageHeader title={tUi("Wrapup Codes")} badges={<Badge variant="secondary">{total}{tUi(" codes")}</Badge>} actions={headerActions} />
      <ConfigurationSectionPage activeId="wrapup-codes">
        <div className="space-y-4">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="grid grid-cols-6 gap-2 items-end">
            <div>
              <label className="text-xs">{tUi("Name")}</label>
              <Input
                value={filters.q}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, q: e.target.value }))
                }
                placeholder={tUi("name, description…")}
              />
            </div>
            <div>
              <label className="text-xs">{tUi("Active")}</label>
              <Select
                value={filters.active || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, active: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={tUi("All")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tUi("All")}</SelectItem>
                  <SelectItem value="true">{tUi("Yes")}</SelectItem>
                  <SelectItem value="false">{tUi("No")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
                    <TableHead className="px-[10px]">{tUi("Name")}</TableHead>
                    <TableHead className="px-[10px]">{tUi("Icon")}</TableHead>
                    <TableHead className="px-[10px]">{tUi("Active")}</TableHead>
                    <TableHead className="px-[10px]">{tUi("Default")}</TableHead>
                    <TableHead className="px-[10px]">{tUi("Display Order")}</TableHead>
                    <TableHead className="px-[10px]">{tUi("Description")}</TableHead>
                    <TableHead className="px-[10px] text-right">{tUi("Actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((code) => {
                    const rowId = code.id;
                    return (
                      <Fragment key={rowId}>
                        <TableRow>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {code.name}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {(() => {
                              const Icon =
                                STATUS_ICON_MAP[code.icon] ||
                                STATUS_NAME_ICON_FALLBACK[code.name] ||
                                STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                              return (
                                <div className="inline-flex items-center gap-2">
                                  <Icon
                                    className="size-4"
                                    style={
                                      code.color
                                        ? { color: code.color }
                                        : undefined
                                    }
                                  />
                                  <span className="text-muted-foreground">
                                    {code.icon || "—"}
                                  </span>
                                </div>
                              );
                            })()}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              variant="outline"
                              className={
                                code.is_active
                                  ? "border-green-500 text-green-600 min-w-[56px] justify-center"
                                  : "border-red-500 text-red-600 min-w-[56px] justify-center"
                              }
                            >
                              {code.is_active ? tUi("YES") : tUi("NO")}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              variant="outline"
                              className={
                                code.is_default
                                  ? "border-blue-500 text-blue-600 min-w-[56px] justify-center"
                                  : "border-slate-300 text-slate-600 min-w-[56px] justify-center"
                              }
                            >
                              {code.is_default ? tUi("YES") : tUi("NO")}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {code.display_order || 0}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs max-w-md truncate">
                            {code.description || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditWrapupCodeId(code.id);
                                  setShowEditSheet(true);
                                }}
                                className="inline-flex items-center text-telnyx-green"
                                title={tUi("Edit wrapup code")}
                              >
                                <IconEdit className="size-4" />
                              </button>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <Can permission="wrapup_codes:delete"><button
                                    type="button"
                                    className="inline-flex items-center text-red-500"
                                    title={tUi("Delete wrapup code")}
                                  >
                                    <IconTrash className="size-4" />
                                  </button></Can>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>{tUi("Delete wrapup code?")}</DialogTitle>
                                    <DialogDescription>{tUi("This action cannot be undone. This will permanently delete the wrapup code \"")}{code.name}&quot;.
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="flex justify-end gap-2 pt-2">
                                    <DialogClose asChild>
                                      <Button variant="outline">{tUi("Cancel")}</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() => onDelete(code.id)}
                                      >{tUi("Delete")}</Button>
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
                      >{tUi("No wrapup codes")}</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
        <div className="px-6 pb-6">
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">{tUi("Total: ")}{total}</div>
            <div className="flex w-full items-center gap-8 lg:w-fit">
              <div className="hidden items-center gap-2 lg:flex">
                <Label htmlFor="rows-per-page" className="text-sm font-medium">{tUi("Rows per page")}</Label>
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
                <span className="text-sm">{tUi("Page ")}{page}{tUi(" of ")}{pageCount}
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
        wrapupCodeId={editWrapupCodeId}
        onSave={load}
      />
        </div>
      </ConfigurationSectionPage>
    </AdminPageShell>
  );
}
