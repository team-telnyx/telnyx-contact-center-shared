"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { IconWorld, IconRefresh } from "@tabler/icons-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ToastNotify";
import { cn } from "@/lib/utils";
import { SecureIframe } from "./SecureIframe";

export function AgentWebPagesView({ selectedInteraction, onBackToInteraction }) {
  const [webPages, setWebPages] = useState([]);
  const [selectedPageId, setSelectedPageId] = useState(null);
  const [selectedPage, setSelectedPage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Restore selected page ID from localStorage after hydration
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("agent-desktop.web-pages.selectedPageId");
        if (saved) {
          setSelectedPageId(saved);
        }
      } catch (_) {}
      setIsHydrated(true);
    }
  }, []);

  // Save selected page ID to localStorage
  useEffect(() => {
    if (typeof window !== "undefined" && selectedPage?.id) {
      try {
        localStorage.setItem("agent-desktop.web-pages.selectedPageId", selectedPage.id);
        setSelectedPageId(selectedPage.id);
      } catch (_) {}
    } else if (!selectedPage && typeof window !== "undefined") {
      try {
        localStorage.removeItem("agent-desktop.web-pages.selectedPageId");
        setSelectedPageId(null);
      } catch (_) {}
    }
  }, [selectedPage?.id]);

  // Load web pages
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/web-pages?activeOnly=true", {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok) {
          setWebPages(data.pages || []);
          // Restore selected page from localStorage if it exists, otherwise select first page
          if (data.pages?.length > 0) {
            // Wait for hydration to complete before restoring
            if (isHydrated && selectedPageId) {
              const savedPage = data.pages.find((p) => p.id === selectedPageId);
              if (savedPage) {
                setSelectedPage(savedPage);
              } else {
                // Saved page no longer exists, select first page
                setSelectedPage(data.pages[0]);
              }
            } else if (!selectedPage) {
              // No saved selection, select first page
              setSelectedPage(data.pages[0]);
            }
          }
        } else {
          notify({
            title: "Load failed",
            description: data?.error || "Failed to fetch web pages",
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
  }, [isHydrated, selectedPageId]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-muted/50 border-b rounded-t-lg">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-primary/10">
            <IconWorld className="h-4 w-4 text-primary" />
          </div>
          <h2 className="text-base font-semibold text-foreground">Web Pages</h2>
        </div>
      </div>

      {/* Tabs Row */}
      <div className="border-b bg-muted/30">
        <div className="flex items-end overflow-x-auto">
          {selectedPage && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 shrink-0 px-3 border-r border-border/50 rounded-none hover:bg-muted/50"
              onClick={() => setRefreshKey((prev) => prev + 1)}
              title="Refresh page"
            >
              <IconRefresh className="h-4 w-4" />
            </Button>
          )}
          {loading ? (
            <div className="flex">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-9 w-24 mx-0.5" />
              ))}
            </div>
          ) : webPages.length === 0 ? (
            <div className="px-4 py-2 text-xs text-muted-foreground">
              No web pages configured
            </div>
          ) : (
            webPages.map((page, index) => (
              <div
                key={page.id}
                className={cn(
                  "relative cursor-pointer transition-all shrink-0 px-4 py-2 border-r border-border/50 border-b border-border",
                  "hover:bg-muted/50",
                )}
                onClick={() => setSelectedPage(page)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="p-0.5 rounded shrink-0 bg-muted text-muted-foreground">
                    <IconWorld className="h-3 w-3" />
                  </div>
                  <div className="font-medium text-xs whitespace-nowrap text-foreground">
                    {page.name}
                  </div>
                </div>
                {selectedPage?.id === page.id && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-green-500" />
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Iframe Panel */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {selectedPage ? (
          <SecureIframe
            url={selectedPage.url}
            title={selectedPage.name}
            refreshKey={refreshKey}
          />
        ) : (
          <div className="flex items-center justify-center flex-1 text-muted-foreground text-sm">
            Select a web page to view
          </div>
        )}
      </div>
    </div>
  );
}
