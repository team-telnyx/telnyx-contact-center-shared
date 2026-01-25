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
  IconBook,
  IconEdit,
  IconTrash,
  IconPlus,
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
import EditSheet from "@/components/kb-articles/EditSheet";

export default function AdminKbArticlesPage() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    status: "all",
    category: "all",
    q: "",
  });
  const [loading, setLoading] = useState(false);
  const [editArticleId, setEditArticleId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);

  function handleNewArticle() {
    setEditArticleId(null);
    setShowEditSheet(true);
  }

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.status && filters.status !== "all")
      sp.set("status", filters.status);
    if (filters.category && filters.category !== "all")
      sp.set("category", filters.category);
    if (filters.q) sp.set("q", filters.q);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/kb-articles?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch KB articles");
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
    const r = await fetch(`/api/admin/kb-articles/${encodeURIComponent(id)}`, {
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

  function statusBadgeColor(status) {
    switch (String(status || "Draft").toLowerCase()) {
      case "published":
        return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
      case "draft":
        return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
      case "archived":
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
      default:
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Get unique categories from items
  const categories = useMemo(() => {
    const cats = new Set();
    items.forEach((item) => {
      if (item.category) cats.add(item.category);
    });
    return Array.from(cats).sort();
  }, [items]);

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconBook className="size-6 text-telnyx-green" /> KB Articles
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  setFilters({
                    status: "all",
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
              <Button onClick={handleNewArticle} variant="default">
                New Article
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-6 gap-2 items-end">
            <div>
              <label className="text-xs">Search</label>
              <Input
                value={filters.q}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, q: e.target.value }))
                }
                placeholder="title, content, tags…"
              />
            </div>
            <div>
              <label className="text-xs">Status</label>
              <Select
                value={filters.status || "all"}
                onValueChange={(value) =>
                  setFilters((f) => ({ ...f, status: value }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="Draft">Draft</SelectItem>
                  <SelectItem value="Published">Published</SelectItem>
                  <SelectItem value="Archived">Archived</SelectItem>
                </SelectContent>
              </Select>
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
                  {categories.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
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
                    <TableHead className="px-[10px] w-[40%]">Title</TableHead>
                    <TableHead className="px-[10px]">Category</TableHead>
                    <TableHead className="px-[10px]">Status</TableHead>
                    <TableHead className="px-[10px]">Author</TableHead>
                    <TableHead className="px-[10px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((article) => {
                    const rowId = article.id;
                    return (
                      <Fragment key={rowId}>
                        <TableRow>
                          <TableCell className="px-[10px] text-xs">
                            <div className="font-medium truncate" title={article.title}>
                              {article.title}
                            </div>
                            {article.summary && (
                              <div className="text-muted-foreground text-xs truncate">
                                {article.summary}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <div>{article.category || "—"}</div>
                            {article.subcategory && (
                              <div className="text-muted-foreground text-xs">
                                {article.subcategory}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              className={
                                statusBadgeColor(article.status) +
                                " justify-center"
                              }
                              variant="outline"
                            >
                              {article.status || "Draft"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {article.author_name || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditArticleId(article.id);
                                  setShowEditSheet(true);
                                }}
                                className="inline-flex items-center text-telnyx-green"
                                title="Edit article"
                              >
                                <IconEdit className="size-4" />
                              </button>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    type="button"
                                    className="inline-flex items-center text-red-500"
                                    title="Delete article"
                                  >
                                    <IconTrash className="size-4" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Delete article?</DialogTitle>
                                    <DialogDescription>
                                      This action cannot be undone. This will
                                      permanently delete the article "
                                      {article.title}".
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="flex justify-end gap-2 pt-2">
                                    <DialogClose asChild>
                                      <Button variant="outline">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() => onDelete(article.id)}
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
                        No KB articles
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
        articleId={editArticleId}
        onSave={load}
      />
    </div>
  );
}

