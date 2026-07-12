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
  IconFileMusic,
  IconTrash,
  IconPlus,
  IconPlayerPlay,
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
import MediaUploadSheet from "@/components/media-library/MediaUploadSheet";
import MediaPlayer from "@/components/media-library/MediaPlayer";

export default function AdminMediaLibraryPage() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    q: "",
  });
  const [loading, setLoading] = useState(false);
  const [showUploadSheet, setShowUploadSheet] = useState(false);
  const [playingMediaName, setPlayingMediaName] = useState(null);

  function handleNewMedia() {
    setShowUploadSheet(true);
  }

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.q) sp.set("q", filters.q);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/media-library?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch media files");
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

  async function onDelete(mediaName) {
    if (!mediaName) return;
    const r = await fetch(
      `/api/admin/media-library/${encodeURIComponent(mediaName)}`,
      {
        method: "DELETE",
      }
    );
    if (r.ok) {
      notify({
        title: "Deleted",
        description: "Media file deleted successfully",
        variant: "success",
      });
      load();
    } else {
      const d = await r.json().catch(() => ({}));
      notify({
        title: "Delete failed",
        description: d?.error || "",
        variant: "error",
      });
    }
  }

  function handlePlay(mediaName) {
    setPlayingMediaName(mediaName);
  }

  function handleClosePlayer() {
    setPlayingMediaName(null);
  }

  function formatDate(dateString) {
    if (!dateString) return "—";
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString() + " " + date.toLocaleTimeString();
    } catch {
      return dateString;
    }
  }

  function getContentTypeInfo(contentType) {
    if (!contentType) return { label: "—", type: "unknown" };
    if (contentType.includes("mpeg") || contentType.includes("mp3"))
      return { label: "MP3", type: "mp3" };
    if (contentType.includes("wav")) return { label: "WAV", type: "wav" };
    return { label: contentType, type: "unknown" };
  }

  function getContentTypeBadgeClass(type) {
    switch (type) {
      case "mp3":
        return "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700";
      case "wav":
        return "bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-700";
      default:
        return "bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700";
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Filter items based on search query (client-side filtering for search)
  const filteredItems = useMemo(() => {
    if (!filters.q) return items;
    const query = filters.q.toLowerCase();
    return items.filter(
      (item) =>
        item.media_name?.toLowerCase().includes(query) ||
        item.content_type?.toLowerCase().includes(query)
    );
  }, [items, filters.q]);

  const headerActions = <>
    <Button
      variant="secondary"
      onClick={() =>
        setFilters({
          q: "",
        })
      }
    >
      Clear
    </Button>
    <Button onClick={() => load()} disabled={loading}>
      {loading ? "Loading…" : "Refresh"}
    </Button>
    <Button onClick={handleNewMedia} variant="default">
      <IconPlus className="size-4 mr-2" />
      Upload Media
    </Button>
  </>;

  return (
    <AdminPageShell>
      <AdminPageHeader title="Media Library" badges={<Badge variant="secondary">{total} assets</Badge>} actions={headerActions} />
      <ConfigurationSectionPage activeId="media-library">
        <div className="space-y-4">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="grid grid-cols-6 gap-2 items-end">
            <div>
              <label className="text-xs">Search</label>
              <Input
                value={filters.q}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, q: e.target.value }))
                }
                placeholder="media name, content type…"
              />
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
                    <TableHead className="px-[10px]">Media Name</TableHead>
                    <TableHead className="px-[10px]">Content Type</TableHead>
                    <TableHead className="px-[10px]">Created At</TableHead>
                    <TableHead className="px-[10px]">Expires At</TableHead>
                    <TableHead className="px-[10px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map((item) => {
                    const rowId = item.media_name;
                    return (
                      <Fragment key={rowId}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => handlePlay(item.media_name)}
                        >
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <IconFileMusic className="size-4 text-telnyx-green" />
                              {item.media_name}
                            </div>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {(() => {
                              const contentTypeInfo = getContentTypeInfo(
                                item.content_type
                              );
                              return (
                                <Badge
                                  variant="outline"
                                  className={getContentTypeBadgeClass(
                                    contentTypeInfo.type
                                  )}
                                >
                                  {contentTypeInfo.label}
                                </Badge>
                              );
                            })()}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {formatDate(item.created_at)}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {item.expires_at ? (
                              formatDate(item.expires_at)
                            ) : (
                              <Badge variant="outline" className="border-green-500 text-green-600">
                                Never
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell
                            className="px-[10px] text-xs whitespace-nowrap text-right"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => handlePlay(item.media_name)}
                                className="inline-flex items-center text-telnyx-green"
                                title="Play media"
                              >
                                <IconPlayerPlay className="size-4" />
                              </button>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    type="button"
                                    className="inline-flex items-center text-red-500"
                                    title="Delete media"
                                  >
                                    <IconTrash className="size-4" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Delete media file?</DialogTitle>
                                    <DialogDescription>
                                      This action cannot be undone. This will
                                      permanently delete the media file "
                                      {item.media_name}".
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="flex justify-end gap-2 pt-2">
                                    <DialogClose asChild>
                                      <Button variant="outline">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() => onDelete(item.media_name)}
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
                  {filteredItems.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-sm text-muted-foreground"
                      >
                        {items.length === 0
                          ? "No media files"
                          : "No media files match your search"}
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
            <div className="text-xs text-muted-foreground">
              Showing: {filteredItems.length} of {total} media files
            </div>
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

      <MediaUploadSheet
        open={showUploadSheet}
        onOpenChange={setShowUploadSheet}
        onUpload={load}
      />

      {playingMediaName && (
        <div className="mt-6">
          <MediaPlayer
            mediaName={playingMediaName}
            onClose={handleClosePlayer}
          />
        </div>
      )}
        </div>
      </ConfigurationSectionPage>
    </AdminPageShell>
  );
}
