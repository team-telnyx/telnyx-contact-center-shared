"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
  IconAddressBook,
  IconEdit,
  IconTrash,
  IconPlus,
  IconUpload,
  IconCode,
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
import ContactEditSheet from "@/components/contacts/EditSheet";
import ContactImportSheet from "@/components/contacts/ImportSheet";
import ApiSchemaSheet from "./ApiSchemaSheet";

export default function ContactsView() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    q: "",
    phone: "",
    email: "",
    company: "",
  });
  const [loading, setLoading] = useState(false);
  const [editContactId, setEditContactId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);
  const [showImportSheet, setShowImportSheet] = useState(false);
  const [showApiSchema, setShowApiSchema] = useState(false);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.q) sp.set("q", filters.q);
    if (filters.phone) sp.set("phone", filters.phone);
    if (filters.email) sp.set("email", filters.email);
    if (filters.company) sp.set("company", filters.company);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/contacts?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch contacts");
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
    const r = await fetch(`/api/contacts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (r.ok) {
      notify({ title: "Contact deleted", variant: "success" });
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

  function formatPhoneNumbers(contact) {
    const phones = [
      contact.phone,
      contact.mobile,
      contact.business_phone_1,
      contact.business_phone_2,
      contact.home_phone_1,
      contact.home_phone_2,
    ]
      .filter(Boolean)
      .slice(0, 2);
    return phones.length > 0 ? phones.join(", ") : "—";
  }

  function formatEmails(contact) {
    const emails = [contact.email_address_1, contact.email_address_2]
      .filter(Boolean)
      .slice(0, 2);
    return emails.length > 0 ? emails.join(", ") : "—";
  }

  function getDisplayName(contact) {
    if (contact.display_name) return contact.display_name;
    const name = [contact.first_name, contact.last_name]
      .filter(Boolean)
      .join(" ");
    return name || contact.company_name || "—";
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconAddressBook className="size-6 text-telnyx-green" /> Contacts
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowApiSchema(true)}>
                <IconCode className="size-4 mr-2" />
                API Schema
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  setFilters({ q: "", phone: "", email: "", company: "" })
                }
              >
                Clear
              </Button>
              <Button onClick={() => load()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowImportSheet(true);
                }}
              >
                <IconUpload className="size-4 mr-2" />
                Import
              </Button>
              <Button
                onClick={() => {
                  setEditContactId(null);
                  setShowEditSheet(true);
                }}
              >
                <IconPlus className="size-4 mr-2" />
                New Contact
              </Button>
            </div>
          </div>
          <div className="flex gap-2 items-end flex-wrap">
            <div style={{ width: "25%", minWidth: "200px" }}>
              <label className="text-xs">Search</label>
              <Input
                value={filters.q}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, q: e.target.value }))
                }
                placeholder="name, company, notes…"
                className="w-full"
              />
            </div>
            <div style={{ width: "20%", minWidth: "150px" }}>
              <label className="text-xs">Phone</label>
              <Input
                value={filters.phone}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, phone: e.target.value }))
                }
                placeholder="phone number…"
                className="w-full"
              />
            </div>
            <div style={{ width: "20%", minWidth: "150px" }}>
              <label className="text-xs">Email</label>
              <Input
                value={filters.email}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, email: e.target.value }))
                }
                placeholder="email address…"
                className="w-full"
              />
            </div>
            <div style={{ width: "20%", minWidth: "150px" }}>
              <label className="text-xs">Company</label>
              <Input
                value={filters.company}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, company: e.target.value }))
                }
                placeholder="company name…"
                className="w-full"
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
                <colgroup>
                  <col style={{ width: "25%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "15%" }} />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-[10px]">Name</TableHead>
                    <TableHead className="px-[10px]">Company</TableHead>
                    <TableHead className="px-[10px]">Phone</TableHead>
                    <TableHead className="px-[10px]">Email</TableHead>
                    <TableHead className="px-[10px] text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((contact) => {
                    const rowId = contact.id;
                    return (
                      <Fragment key={rowId}>
                        <TableRow>
                          <TableCell className="px-[10px] text-xs">
                            {getDisplayName(contact)}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {contact.company_name || "—"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {formatPhoneNumbers(contact)}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {formatEmails(contact)}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditContactId(contact.id);
                                  setShowEditSheet(true);
                                }}
                                className="inline-flex items-center text-telnyx-green"
                                title="Edit contact"
                              >
                                <IconEdit className="size-4" />
                              </button>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    type="button"
                                    className="inline-flex items-center text-red-500"
                                    title="Delete contact"
                                  >
                                    <IconTrash className="size-4" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Delete contact?</DialogTitle>
                                    <DialogDescription>
                                      This action cannot be undone. This will
                                      permanently delete the contact "
                                      {getDisplayName(contact)}".
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="flex justify-end gap-2 pt-2">
                                    <DialogClose asChild>
                                      <Button variant="outline">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() => onDelete(contact.id)}
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
                        No contacts
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
      <ContactEditSheet
        open={showEditSheet}
        onOpenChange={setShowEditSheet}
        contactId={editContactId}
        onSaveComplete={load}
      />

      {/* Import Sheet */}
      <ContactImportSheet
        open={showImportSheet}
        onOpenChange={setShowImportSheet}
        onImportComplete={load}
      />

      {/* API Schema Sheet */}
      <ApiSchemaSheet
        entityId="contacts"
        basePath="/api/contacts"
        dbTable="contacts"
        open={showApiSchema}
        onOpenChange={setShowApiSchema}
      />
    </>
  );
}
