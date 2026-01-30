"use client";

import { useState, useEffect, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  IconChecklist,
  IconSearch,
  IconPlus,
  IconPhone,
  IconMail,
  IconCalendar,
  IconTag,
  IconUser,
  IconClock,
  IconX,
  IconEdit,
} from "@tabler/icons-react";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ToastNotify";
import { cn } from "@/lib/utils";
import TaskEditSheet from "@/components/tasks/EditSheet";

export function AgentTasksView({ selectedInteraction, onBackToInteraction }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedItem, setExpandedItem] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);

  // Restore state from localStorage after hydration
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const savedSearch = localStorage.getItem("agent-desktop.tasks.searchQuery");
        if (savedSearch) {
          setSearchQuery(savedSearch);
        }
        const savedExpanded = localStorage.getItem("agent-desktop.tasks.expandedItem");
        if (savedExpanded) {
          setExpandedItem(savedExpanded);
        }
      } catch (_) {}
      setIsHydrated(true);
    }
  }, []);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [identifiedContact, setIdentifiedContact] = useState(null);
  const [showTaskSheet, setShowTaskSheet] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [prefillContactId, setPrefillContactId] = useState(null);
  const [contactsMap, setContactsMap] = useState(new Map());

  // Save search query to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        if (searchQuery) {
          localStorage.setItem("agent-desktop.tasks.searchQuery", searchQuery);
        } else {
          localStorage.removeItem("agent-desktop.tasks.searchQuery");
        }
      } catch (_) {}
    }
  }, [searchQuery]);

  // Save expanded item to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        if (expandedItem) {
          localStorage.setItem("agent-desktop.tasks.expandedItem", expandedItem);
        } else {
          localStorage.removeItem("agent-desktop.tasks.expandedItem");
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
          const contact = data.rows[0];
          setIdentifiedContact(contact);
          setPrefillContactId(contact.id);
          // Auto-filter to show tasks for this contact
          setSearchQuery(contact.id);
        } else {
          setIdentifiedContact(null);
          setPrefillContactId(null);
        }
      } catch (err) {
        console.error("Failed to identify caller:", err);
        setIdentifiedContact(null);
        setPrefillContactId(null);
      }
    }

    identifyCaller();
  }, [selectedInteraction?.from_number]);

  // Load tasks
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const query = new URLSearchParams();
        // Always prioritize identified contact ID when available (for connected calls)
        // This ensures tasks are filtered by the caller's contact_id
        if (prefillContactId) {
          query.set("contact_id", prefillContactId);
        } else if (searchQuery) {
          // Only use search query if no identified contact
          query.set("q", searchQuery);
        }
        query.set("pageSize", "50");

        const res = await fetch(`/api/tasks?${query}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok) {
          const tasks = data.rows || [];
          setItems(tasks);

          // Fetch contacts for tasks that have contact_id (to display as caller info)
          const contactIdsToFetch = new Set();
          tasks.forEach((task) => {
            if (task.contact_id) {
              contactIdsToFetch.add(task.contact_id);
            }
          });

          // Fetch contacts individually (since we need specific IDs)
          if (contactIdsToFetch.size > 0) {
            const contactPromises = Array.from(contactIdsToFetch).map(
              async (contactId) => {
                // Skip if we already have this contact
                if (contactsMap.has(contactId)) {
                  return null;
                }
                try {
                  const contactRes = await fetch(
                    `/api/contacts/${encodeURIComponent(contactId)}`,
                    { cache: "no-store" },
                  );
                  if (contactRes.ok) {
                    const contact = await contactRes.json();
                    return { contactId, contact };
                  }
                } catch (err) {
                  console.error(`Failed to fetch contact ${contactId}:`, err);
                }
                return null;
              },
            );

            const contactResults = await Promise.all(contactPromises);
            const newContactsMap = new Map(contactsMap);
            contactResults.forEach((result) => {
              if (result && result.contact) {
                newContactsMap.set(result.contactId, result.contact);
              }
            });
            if (newContactsMap.size !== contactsMap.size) {
              setContactsMap(newContactsMap);
            }
          }
        } else {
          notify({
            title: "Load failed",
            description: data?.error || "Failed to fetch tasks",
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
    }

    load();
  }, [searchQuery, prefillContactId]);

  // Clear search query when call disconnects
  useEffect(() => {
    const handleCallDisconnected = () => {
      setSearchQuery("");
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

  function statusBadgeColor(status) {
    switch (String(status || "open").toLowerCase()) {
      case "open":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
      case "in_progress":
        return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
      case "resolved":
        return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
      case "closed":
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
      case "cancelled":
        return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
      default:
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    }
  }

  function priorityBadgeColor(priority) {
    switch (String(priority || "medium").toLowerCase()) {
      case "low":
        return "bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300";
      case "medium":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
      case "high":
        return "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300";
      case "urgent":
        return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
      default:
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
    }
  }

  function formatDate(dateString) {
    if (!dateString) return "—";
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  }

  function formatStatus(status) {
    if (!status) return "OPEN";
    return String(status)
      .replace(/_/g, " ")
      .toUpperCase();
  }

  function formatPriority(priority) {
    if (!priority) return "MEDIUM";
    return String(priority).toUpperCase();
  }

  // Helper function to get caller information from task or contact
  function getCallerInfo(task) {
    const contact = task.contact_id ? contactsMap.get(task.contact_id) : null;

    // Get name: prefer task caller_name, fallback to contact
    const callerName =
      task.caller_name ||
      (contact
        ? contact.display_name ||
          [contact.first_name, contact.last_name]
            .filter(Boolean)
            .join(" ") ||
          contact.company_name
        : null);

    // Get phone: prefer task caller_phone, fallback to contact
    const callerPhone =
      task.caller_phone ||
      (contact
        ? contact.phone ||
          contact.mobile ||
          contact.business_phone_1 ||
          contact.business_phone_2 ||
          contact.home_phone_1 ||
          contact.home_phone_2
        : null);

    // Get email: prefer task caller_email, fallback to contact
    const callerEmail =
      task.caller_email ||
      (contact ? contact.email_address_1 || contact.email_address_2 : null);

    return { callerName, callerPhone, callerEmail };
  }

  // Clear expanded item if it no longer exists in the list
  useEffect(() => {
    if (expandedItem && items.length > 0) {
      const itemExists = items.some((item) => item.id === expandedItem);
      if (!itemExists) {
        setExpandedItem("");
      }
    }
  }, [expandedItem, items]);

  async function handleCreateTask() {
    if (!identifiedContact) {
      // Show option to create contact first
      const shouldCreate = confirm(
        "Caller is not registered. Would you like to create a contact first?",
      );
      if (shouldCreate) {
        // Redirect to create contact (we'll handle this differently)
        notify({
          title: "Create Contact",
          description:
            "Please create a contact first, then create a task for them.",
          variant: "info",
        });
        return;
      }
    }
    setShowTaskSheet(true);
  }

  async function handleTaskSaved() {
    setShowTaskSheet(false);
    setEditingTaskId(null);
    // Reload tasks - always prioritize identified contact ID
    setLoading(true);
    try {
      const query = new URLSearchParams();
      // Always prioritize identified contact ID when available
      if (prefillContactId) {
        query.set("contact_id", prefillContactId);
      } else if (searchQuery) {
        query.set("q", searchQuery);
      }
      query.set("pageSize", "50");
      const res = await fetch(`/api/tasks?${query}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        const tasks = data.rows || [];
        setItems(tasks);

        // Reload contacts if needed
        const contactIdsToFetch = new Set();
        tasks.forEach((task) => {
          if (task.contact_id) {
            contactIdsToFetch.add(task.contact_id);
          }
        });

        if (contactIdsToFetch.size > 0) {
          const contactPromises = Array.from(contactIdsToFetch).map(
            async (contactId) => {
              if (contactsMap.has(contactId)) {
                return null;
              }
              try {
                const contactRes = await fetch(
                  `/api/contacts/${encodeURIComponent(contactId)}`,
                  { cache: "no-store" },
                );
                if (contactRes.ok) {
                  const contact = await contactRes.json();
                  return { contactId, contact };
                }
              } catch (err) {
                console.error(`Failed to fetch contact ${contactId}:`, err);
              }
              return null;
            },
          );

          const contactResults = await Promise.all(contactPromises);
          const newContactsMap = new Map(contactsMap);
          contactResults.forEach((result) => {
            if (result && result.contact) {
              newContactsMap.set(result.contactId, result.contact);
            }
          });
          if (newContactsMap.size !== contactsMap.size) {
            setContactsMap(newContactsMap);
          }
        }
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
  }

  function handleEditTask(taskId) {
    setEditingTaskId(taskId);
    setShowTaskSheet(true);
  }

  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="p-4 border-b">
          <div className="flex items-center gap-2 mb-3">
            <IconChecklist className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Tasks</h3>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <IconSearch className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tasks..."
                className="pl-8 pr-8"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-sm hover:bg-muted transition-colors"
                  aria-label="Clear search"
                >
                  <IconX className="h-3 w-3 text-muted-foreground" />
                </button>
              )}
            </div>
            <Button
              size="sm"
              onClick={handleCreateTask}
              className="h-8 shrink-0"
            >
              <IconPlus className="h-3 w-3 mr-1" />
              New Task
            </Button>
          </div>
          {identifiedContact && (
            <div className="mt-2 text-xs text-muted-foreground">
              Showing tasks for: {identifiedContact.display_name || 
                [identifiedContact.first_name, identifiedContact.last_name].filter(Boolean).join(" ") ||
                "Unnamed Contact"}
            </div>
          )}
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4">
            {loading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="text-center text-muted-foreground py-8 text-sm">
                No tasks found
              </div>
            ) : (
              <Accordion
                type="single"
                collapsible
                className="space-y-2"
                value={expandedItem}
                onValueChange={setExpandedItem}
              >
                {items.map((task) => {
                  return (
                    <AccordionItem
                      key={task.id}
                      value={task.id}
                      className="border rounded-lg px-4 !border-b"
                    >
                      <AccordionTrigger className="hover:no-underline py-3">
                        <div className="flex items-center gap-3 flex-1 text-left">
                          <div className="p-2 rounded-md bg-muted">
                            <IconChecklist className="h-4 w-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-sm mb-1">
                              {task.title}
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge
                                className={cn(
                                  statusBadgeColor(task.status),
                                  "text-xs",
                                )}
                                variant="outline"
                              >
                                {formatStatus(task.status)}
                              </Badge>
                              <Badge
                                className={cn(
                                  priorityBadgeColor(task.priority),
                                  "text-xs",
                                )}
                                variant="outline"
                              >
                                {formatPriority(task.priority)}
                              </Badge>
                              {(() => {
                                const { callerName } = getCallerInfo(task);
                                return callerName ? (
                                  <span className="text-xs text-muted-foreground">
                                    {callerName}
                                  </span>
                                ) : null;
                              })()}
                            </div>
                          </div>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="pb-4 pt-0">
                        <div className="space-y-4 text-sm">
                          {/* Description */}
                          {task.description && (
                            <div className="space-y-2">
                              <div className="text-xs font-medium text-muted-foreground">
                                Description
                              </div>
                              <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded-md whitespace-pre-wrap">
                                {task.description}
                              </div>
                            </div>
                          )}

                          {/* Task Type */}
                          {task.task_type && (
                            <div className="space-y-2">
                              <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                                <IconTag className="h-3 w-3" />
                                Task Type
                              </div>
                              <Badge
                                variant="outline"
                                className="bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-300 dark:border-indigo-800"
                              >
                                {task.task_type
                                  .replace(/_/g, " ")
                                  .replace(/\b\w/g, (l) => l.toUpperCase())}
                              </Badge>
                            </div>
                          )}

                          {/* Caller Information */}
                          {(() => {
                            const { callerName, callerPhone, callerEmail } =
                              getCallerInfo(task);
                            if (callerName || callerPhone || callerEmail) {
                              return (
                                <div className="space-y-2">
                                  <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                                    <IconUser className="h-3 w-3" />
                                    Caller Information
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {callerName && (
                                      <Badge
                                        variant="outline"
                                        className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800"
                                      >
                                        <IconUser className="h-3 w-3 mr-1" />
                                        {callerName}
                                      </Badge>
                                    )}
                                    {callerPhone && (
                                      <Badge
                                        variant="outline"
                                        className="bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800"
                                      >
                                        <IconPhone className="h-3 w-3 mr-1" />
                                        {callerPhone}
                                      </Badge>
                                    )}
                                    {callerEmail && (
                                      <Badge
                                        variant="outline"
                                        className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800"
                                      >
                                        <IconMail className="h-3 w-3 mr-1" />
                                        {callerEmail}
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                              );
                            }
                            return null;
                          })()}

                          {/* Dates */}
                          {(task.created_at || task.due_date) && (
                            <div className="space-y-2">
                              <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                                <IconCalendar className="h-3 w-3" />
                                Dates
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {task.created_at && (
                                  <Badge
                                    variant="outline"
                                    className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600"
                                  >
                                    <IconClock className="h-3 w-3 mr-1" />
                                    Created: {formatDate(task.created_at)}
                                  </Badge>
                                )}
                                {task.due_date && (
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "border",
                                      new Date(task.due_date) < new Date()
                                        ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800"
                                        : "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-300 dark:border-yellow-800",
                                    )}
                                  >
                                    <IconCalendar className="h-3 w-3 mr-1" />
                                    Due: {formatDate(task.due_date)}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Tags */}
                          {task.tags && (
                            <div className="space-y-2">
                              <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                                <IconTag className="h-3 w-3" />
                                Tags
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {typeof task.tags === "string" ? (
                                  <Badge
                                    variant="outline"
                                    className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600"
                                  >
                                    {task.tags}
                                  </Badge>
                                ) : Array.isArray(task.tags) ? (
                                  task.tags.map((tag, idx) => (
                                    <Badge
                                      key={idx}
                                      variant="outline"
                                      className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600"
                                    >
                                      {tag}
                                    </Badge>
                                  ))
                                ) : null}
                              </div>
                            </div>
                          )}

                          {/* Edit Button */}
                          <div className="flex justify-end pt-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleEditTask(task.id)}
                              className="h-8"
                            >
                              <IconEdit className="h-3 w-3 mr-1" />
                              Edit Task
                            </Button>
                          </div>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Task Edit Sheet */}
      {showTaskSheet && (
        <TaskEditSheet
          open={showTaskSheet}
          onOpenChange={(open) => {
            setShowTaskSheet(open);
            if (!open) {
              setEditingTaskId(null);
            }
          }}
          taskId={editingTaskId}
          onSaveComplete={handleTaskSaved}
          prefillContactId={
            editingTaskId ? undefined : prefillContactId
          }
          prefillCallerData={
            editingTaskId
              ? undefined
              : identifiedContact && selectedInteraction
                ? {
                    callerName:
                      identifiedContact.display_name ||
                      [identifiedContact.first_name, identifiedContact.last_name]
                        .filter(Boolean)
                        .join(" ") ||
                      "Unnamed Contact",
                    callerPhone: selectedInteraction.from_number,
                    callerEmail:
                      identifiedContact.email_address_1 ||
                      identifiedContact.email_address_2 ||
                      "",
                  }
                : undefined
          }
        />
      )}
    </>
  );
}
