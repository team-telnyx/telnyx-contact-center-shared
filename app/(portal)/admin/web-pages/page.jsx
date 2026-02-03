"use client";

import { Fragment, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { IconWorld, IconEdit, IconTrash, IconPlus } from "@tabler/icons-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import WebPageEditSheet from "@/components/web-pages/EditSheet";

export default function AdminWebPagesPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editPageId, setEditPageId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);

  function handleNewPage() {
    setEditPageId(null);
    setShowEditSheet(true);
  }

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/web-pages", {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch web pages");
      setItems(data.pages || []);
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
  }, []);

  async function onDelete(id) {
    if (!id) return;
    const r = await fetch(`/api/admin/web-pages/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (r.ok) {
      notify({ title: "Web page deleted", variant: "success" });
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

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconWorld className="size-6 text-telnyx-green" /> Web Pages
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => load()}
                disabled={loading}
              >
                {loading ? "Loading…" : "Refresh"}
              </Button>
              <Button onClick={handleNewPage}>
                <IconPlus className="size-4 mr-2" />
                New Web Page
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="border rounded-md overflow-hidden p-4 space-y-2">
              <Skeleton className="h-6 w-40" />
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-[10px]">Name</TableHead>
                    <TableHead className="px-[10px]">URL</TableHead>
                    <TableHead className="px-[10px]">Description</TableHead>
                    <TableHead className="px-[10px]">Status</TableHead>
                    <TableHead className="px-[10px]">Order</TableHead>
                    <TableHead className="px-[10px] text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((page) => {
                    return (
                      <Fragment key={page.id}>
                        <TableRow>
                          <TableCell className="px-[10px] text-xs">
                            <div className="font-medium">{page.name}</div>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <a
                              href={page.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline truncate block max-w-xs"
                            >
                              {page.url}
                            </a>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {page.description || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            <Badge
                              variant={page.is_active ? "default" : "secondary"}
                            >
                              {page.is_active ? "Active" : "Inactive"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {page.order_index || 0}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditPageId(page.id);
                                  setShowEditSheet(true);
                                }}
                                className="inline-flex items-center text-telnyx-green"
                                title="Edit web page"
                              >
                                <IconEdit className="size-4" />
                              </button>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    type="button"
                                    className="inline-flex items-center text-red-500"
                                    title="Delete web page"
                                  >
                                    <IconTrash className="size-4" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Delete web page?</DialogTitle>
                                    <DialogDescription>
                                      This action cannot be undone. This will
                                      permanently delete the web page "
                                      {page.name}".
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="flex justify-end gap-2 pt-2">
                                    <DialogClose asChild>
                                      <Button variant="outline">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() => onDelete(page.id)}
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
                        colSpan={6}
                        className="text-center py-8 text-sm text-muted-foreground"
                      >
                        No web pages configured
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Sheet */}
      <WebPageEditSheet
        open={showEditSheet}
        onOpenChange={setShowEditSheet}
        pageId={editPageId}
        onSaveComplete={load}
      />
    </div>
  );
}
