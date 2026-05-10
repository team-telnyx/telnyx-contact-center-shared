"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  IconAddressBook,
  IconSearch,
  IconPhone,
  IconMail,
  IconBuilding,
  IconMapPin,
  IconBriefcase,
  IconUser,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ToastNotify";
import { cn } from "@/lib/utils";
import ContactEditSheet from "@/components/contacts/EditSheet";
import { AgentDataSourcePagination } from "./AgentDataSourcePagination";

export function AgentContactsView({ selectedInteraction, onBackToInteraction }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedItem, setExpandedItem] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);

  // Restore state from localStorage after hydration
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const savedSearch = localStorage.getItem("agent-desktop.contacts.searchQuery");
        if (savedSearch) {
          setSearchQuery(savedSearch);
        }
        const savedExpanded = localStorage.getItem("agent-desktop.contacts.expandedItem");
        if (savedExpanded) {
          setExpandedItem(savedExpanded);
        }
      } catch (_) {}
      setIsHydrated(true);
    }
  }, []);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalCount, setTotalCount] = useState(0);
  const [identifiedContact, setIdentifiedContact] = useState(null);
  const [showContactSheet, setShowContactSheet] = useState(false);

  // Save search query to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        if (searchQuery) {
          localStorage.setItem("agent-desktop.contacts.searchQuery", searchQuery);
        } else {
          localStorage.removeItem("agent-desktop.contacts.searchQuery");
        }
      } catch (_) {}
    }
  }, [searchQuery]);

  // Save expanded item to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        if (expandedItem) {
          localStorage.setItem("agent-desktop.contacts.expandedItem", expandedItem);
        } else {
          localStorage.removeItem("agent-desktop.contacts.expandedItem");
        }
      } catch (_) {}
    }
  }, [expandedItem]);

  // Identify caller when interaction is selected
  useEffect(() => {
    async function identifyCaller() {
      if (!selectedInteraction?.from_number) {
        setIdentifiedContact(null);
        return;
      }

      try {
        const res = await fetch(
          `/api/contacts?phone=${encodeURIComponent(selectedInteraction.from_number)}&pageSize=1`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (res.ok && data.rows?.length > 0) {
          setIdentifiedContact(data.rows[0]);
          // Auto-filter to show this contact
          setSearchQuery(selectedInteraction.from_number);
        } else {
          setIdentifiedContact(null);
        }
      } catch (err) {
        console.error("Failed to identify caller:", err);
        setIdentifiedContact(null);
      }
    }

    identifyCaller();
  }, [selectedInteraction?.from_number]);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      // If there's a connected call, search by phone number specifically
      if (selectedInteraction?.from_number && searchQuery === selectedInteraction.from_number) {
        query.set("phone", selectedInteraction.from_number);
      } else if (searchQuery) {
        // Otherwise use general search
        query.set("q", searchQuery);
      }
      query.set("page", String(page));
      query.set("pageSize", String(pageSize));

      const res = await fetch(`/api/contacts?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.ok) {
        setItems(data.rows || []);
        setTotalCount(Number(data.count || 0));
      } else {
        notify({
          title: "Load failed",
          description: data?.error || "Failed to fetch contacts",
          variant: "error",
        });
      }
    } catch (err) {
      notify({
        title: "Load failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, searchQuery, selectedInteraction?.from_number]);

  // Load contacts
  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, selectedInteraction?.from_number]);

  // Clear search query when call disconnects
  useEffect(() => {
    const handleCallDisconnected = () => {
      setSearchQuery("");
      setPage(1);
    };

    window.addEventListener(
      "contact-center:call-disconnected",
      handleCallDisconnected,
    );

    return () => {
      window.removeEventListener(
        "contact-center:call-disconnected",
        handleCallDisconnected,
      );
    };
  }, []);

  // Filter items to highlight identified contact
  const filteredItems = useMemo(() => {
    if (!identifiedContact) return items;
    // Put identified contact first
    const identified = items.find((c) => c.id === identifiedContact.id);
    const others = items.filter((c) => c.id !== identifiedContact.id);
    return identified ? [identified, ...others] : items;
  }, [items, identifiedContact]);

  // Clear expanded item if it no longer exists in the filtered list
  useEffect(() => {
    if (expandedItem && filteredItems.length > 0) {
      const itemExists = filteredItems.some((item) => item.id === expandedItem);
      if (!itemExists) {
        setExpandedItem("");
      }
    }
  }, [expandedItem, filteredItems]);

  function getDisplayName(contact) {
    if (contact.display_name) return contact.display_name;
    const name = [contact.first_name, contact.last_name]
      .filter(Boolean)
      .join(" ");
    return name || contact.company_name || "Unnamed Contact";
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
      .slice(0, 3);
    return phones;
  }

  function formatEmails(contact) {
    return [contact.email_address_1, contact.email_address_2].filter(Boolean);
  }

  async function handleContactSaved() {
    setShowContactSheet(false);
    await loadContacts();
  }

  return (
    <>
      <div className="flex flex-col h-full min-h-0 overflow-hidden">
        <div className="shrink-0 p-4 border-b">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <IconSearch className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Search by name, phone, email, company..."
                className="pl-8 pr-8"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setPage(1);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-sm hover:bg-muted transition-colors"
                  aria-label="Clear search"
                >
                  <IconX className="h-3 w-3 text-muted-foreground" />
                </button>
              )}
            </div>
            <Button
              size="sm"
              onClick={() => setShowContactSheet(true)}
              className="h-8 shrink-0"
            >
              <IconPlus className="h-3 w-3 mr-1" />
              New Contact
            </Button>
          </div>
        {identifiedContact && (
          <div className="mt-2 text-xs text-muted-foreground">
            Caller identified: {getDisplayName(identifiedContact)}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4">
          {loading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="text-center text-muted-foreground py-8 text-sm">
              No contacts found
            </div>
          ) : (
            <Accordion
              type="single"
              collapsible
              className="space-y-2"
              value={expandedItem}
              onValueChange={setExpandedItem}
            >
              {filteredItems.map((contact) => {
                const isIdentified = identifiedContact?.id === contact.id;
                const phones = formatPhoneNumbers(contact);
                const emails = formatEmails(contact);

                return (
                  <AccordionItem
                    key={contact.id}
                    value={contact.id}
                    className={cn(
                      "border rounded-lg px-4 !border-b",
                      isIdentified && "ring-2 ring-primary bg-primary/5",
                    )}
                  >
                    <AccordionTrigger className="hover:no-underline py-3">
                      <div className="flex items-center gap-3 flex-1 text-left">
                        <div
                          className={cn(
                            "p-2 rounded-md",
                            isIdentified
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted",
                          )}
                        >
                          <IconAddressBook className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm">
                            {getDisplayName(contact)}
                            {isIdentified && (
                              <span className="ml-2 text-xs text-primary">
                                (Caller)
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {contact.company_name || "—"}
                            {phones.length > 0 && ` • ${phones[0]}`}
                          </div>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-4 pt-0">
                      <div className="space-y-4 text-sm">
                        {/* Contact Info - Phones & Emails */}
                        <div className="space-y-2">
                          {phones.length > 0 && (
                            <div>
                              <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                                <IconPhone className="h-3 w-3" />
                                Phone Numbers
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {phones.map((phone, idx) => (
                                  <Badge
                                    key={idx}
                                    variant="outline"
                                    className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800"
                                  >
                                    <IconPhone className="h-3 w-3 mr-1" />
                                    {phone}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {emails.length > 0 && (
                            <div>
                              <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                                <IconMail className="h-3 w-3" />
                                Email Addresses
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {emails.map((email, idx) => (
                                  <Badge
                                    key={idx}
                                    variant="outline"
                                    className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800"
                                  >
                                    <IconMail className="h-3 w-3 mr-1" />
                                    {email}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Company & Role */}
                        {(contact.company_name ||
                          contact.title ||
                          contact.department) && (
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                              <IconBuilding className="h-3 w-3" />
                              Company & Role
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {contact.company_name && (
                                <Badge
                                  variant="outline"
                                  className="bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800"
                                >
                                  <IconBuilding className="h-3 w-3 mr-1" />
                                  {contact.company_name}
                                </Badge>
                              )}
                              {contact.title && (
                                <Badge
                                  variant="outline"
                                  className="bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/20 dark:text-orange-300 dark:border-orange-800"
                                >
                                  <IconBriefcase className="h-3 w-3 mr-1" />
                                  {contact.title}
                                </Badge>
                              )}
                              {contact.department && (
                                <Badge
                                  variant="outline"
                                  className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600"
                                >
                                  {contact.department}
                                </Badge>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Personal Info */}
                        {(contact.first_name || contact.last_name) && (
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                              <IconUser className="h-3 w-3" />
                              Personal Information
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {contact.first_name && (
                                <Badge
                                  variant="outline"
                                  className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600"
                                >
                                  First: {contact.first_name}
                                </Badge>
                              )}
                              {contact.last_name && (
                                <Badge
                                  variant="outline"
                                  className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600"
                                >
                                  Last: {contact.last_name}
                                </Badge>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Address */}
                        {(contact.address_1 ||
                          contact.city ||
                          contact.state ||
                          contact.postal_code) && (
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                              <IconMapPin className="h-3 w-3" />
                              Address
                            </div>
                            <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded-md">
                              {[
                                contact.address_1,
                                contact.address_2,
                                contact.city,
                                contact.state,
                                contact.postal_code,
                              ]
                                .filter(Boolean)
                                .join(", ")}
                            </div>
                          </div>
                        )}

                        {/* Notes */}
                        {contact.notes && (
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground mb-1.5">
                              Notes
                            </div>
                            <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded-md whitespace-pre-wrap">
                              {contact.notes}
                            </div>
                          </div>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          )}
        </div>
      </ScrollArea>
      <AgentDataSourcePagination
        page={page}
        pageSize={pageSize}
        totalCount={totalCount}
        loading={loading}
        onPageChange={setPage}
        onPageSizeChange={(nextPageSize) => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
      />
      </div>

      {/* Contact Edit Sheet */}
      {showContactSheet && (
        <ContactEditSheet
          open={showContactSheet}
          onOpenChange={setShowContactSheet}
          contactId={null}
          onSaveComplete={handleContactSaved}
          prefillPhone={selectedInteraction?.from_number}
        />
      )}
    </>
  );
}
