"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  IconBook,
  IconSearch,
  IconTag,
  IconUser,
  IconCalendar,
  IconClock,
  IconX,
} from "@tabler/icons-react";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ToastNotify";
import { AgentDataSourcePagination } from "./AgentDataSourcePagination";

export function AgentKbArticlesView({ selectedInteraction, onBackToInteraction }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedItem, setExpandedItem] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);

  // Restore state from localStorage after hydration
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const savedSearch = localStorage.getItem("agent-desktop.kb-articles.searchQuery");
        if (savedSearch) {
          setSearchQuery(savedSearch);
        }
        const savedExpanded = localStorage.getItem("agent-desktop.kb-articles.expandedItem");
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

  // Save search query to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        if (searchQuery) {
          localStorage.setItem("agent-desktop.kb-articles.searchQuery", searchQuery);
        } else {
          localStorage.removeItem("agent-desktop.kb-articles.searchQuery");
        }
      } catch (_) {}
    }
  }, [searchQuery]);

  // Save expanded item to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        if (expandedItem) {
          localStorage.setItem("agent-desktop.kb-articles.expandedItem", expandedItem);
        } else {
          localStorage.removeItem("agent-desktop.kb-articles.expandedItem");
        }
      } catch (_) {}
    }
  }, [expandedItem]);

  const loadArticles = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (searchQuery) {
        query.set("q", searchQuery);
      }
      query.set("page", String(page));
      query.set("pageSize", String(pageSize));
      query.set("status", "Published"); // Only show published articles

      const res = await fetch(`/api/admin/kb-articles?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.ok) {
        setItems(data.items || []);
        setTotalCount(Number(data.total || 0));
      } else {
        notify({
          title: "Load failed",
          description: data?.error || "Failed to fetch KB articles",
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
  }, [page, pageSize, searchQuery]);

  // Load KB articles
  useEffect(() => {
    loadArticles();
  }, [loadArticles]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery]);

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

  // Clear expanded item if it no longer exists in the list
  useEffect(() => {
    if (expandedItem && items.length > 0) {
      const itemExists = items.some((item) => item.id === expandedItem);
      if (!itemExists) {
        setExpandedItem("");
      }
    }
  }, [expandedItem, items]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <div className="shrink-0 p-4 border-b">
        <div className="relative">
          <IconSearch className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search articles..."
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
      </div>

      <ScrollArea className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4">
          {loading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="text-center text-muted-foreground py-8 text-sm">
              No articles found
            </div>
          ) : (
            <Accordion
              type="single"
              collapsible
              className="space-y-2"
              value={expandedItem}
              onValueChange={setExpandedItem}
            >
              {items.map((article) => {
                return (
                  <AccordionItem
                    key={article.id}
                    value={article.id}
                    className="border rounded-lg px-4 !border-b"
                  >
                    <AccordionTrigger className="hover:no-underline py-3">
                      <div className="flex items-center gap-3 flex-1 text-left">
                        <div className="p-2 rounded-md bg-amber-500/10">
                          <IconBook className="h-4 w-4 text-amber-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm mb-1">
                            {article.title}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge
                              className={statusBadgeColor(article.status)}
                              variant="outline"
                            >
                              {article.status || "Draft"}
                            </Badge>
                            {article.category && (
                              <span className="text-xs text-muted-foreground">
                                {article.category}
                              </span>
                            )}
                            {article.author_name && (
                              <span className="text-xs text-muted-foreground">
                                by {article.author_name}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-4 pt-0">
                      <div className="space-y-4 text-sm">
                        {/* Summary */}
                        {article.summary && (
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">
                              Summary
                            </div>
                            <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded-md">
                              {article.summary}
                            </div>
                          </div>
                        )}

                        {/* Content */}
                        {article.content && (
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">
                              Content
                            </div>
                            <div
                              className="text-xs text-muted-foreground prose prose-sm max-w-none bg-muted/50 p-2 rounded-md"
                              dangerouslySetInnerHTML={{
                                __html: article.content,
                              }}
                            />
                          </div>
                        )}

                        {/* Category and Subcategory */}
                        {(article.category || article.subcategory) && (
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                              <IconTag className="h-3 w-3" />
                              Category
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {article.category && (
                                <Badge
                                  variant="outline"
                                  className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800"
                                >
                                  {article.category}
                                </Badge>
                              )}
                              {article.subcategory && (
                                <Badge
                                  variant="outline"
                                  className="bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-300 dark:border-indigo-800"
                                >
                                  {article.subcategory}
                                </Badge>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Tags */}
                        {article.tags &&
                          Array.isArray(article.tags) &&
                          article.tags.length > 0 && (
                            <div className="space-y-2">
                              <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                                <IconTag className="h-3 w-3" />
                                Tags
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {article.tags.map((tag, idx) => (
                                  <Badge
                                    key={idx}
                                    variant="outline"
                                    className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600"
                                  >
                                    {tag}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}

                        {/* Author and Dates */}
                        {(article.author_name ||
                          article.created_at ||
                          article.updated_at) && (
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                              <IconUser className="h-3 w-3" />
                              Metadata
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {article.author_name && (
                                <Badge
                                  variant="outline"
                                  className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800"
                                >
                                  <IconUser className="h-3 w-3 mr-1" />
                                  {article.author_name}
                                </Badge>
                              )}
                              {article.created_at && (
                                <Badge
                                  variant="outline"
                                  className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600"
                                >
                                  <IconClock className="h-3 w-3 mr-1" />
                                  Created:{" "}
                                  {new Date(article.created_at).toLocaleDateString()}
                                </Badge>
                              )}
                              {article.updated_at && (
                                <Badge
                                  variant="outline"
                                  className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600"
                                >
                                  <IconCalendar className="h-3 w-3 mr-1" />
                                  Updated:{" "}
                                  {new Date(article.updated_at).toLocaleDateString()}
                                </Badge>
                              )}
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
  );
}
