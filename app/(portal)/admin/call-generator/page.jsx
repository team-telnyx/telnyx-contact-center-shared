"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { IconRefresh } from "@tabler/icons-react";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import {
  CALL_GENERATOR_ACTIVE_SECTION_STORAGE_KEY,
  CALL_GENERATOR_RAIL_ITEMS,
  persistCallGeneratorSection,
} from "@/components/contact-center/CallGeneratorSectionNav";
import CallGeneratorDashboardView from "@/components/contact-center/CallGeneratorDashboardView";
import CallGeneratorScenariosView from "@/components/contact-center/CallGeneratorScenariosView";
import CallGeneratorSettingsView from "@/components/contact-center/CallGeneratorSettingsView";

const SECTION_META = {
  dashboard: {
    kicker: "Call generator",
    title: "Live test runs and metrics",
    description: "Monitor active generated calls, answer rates, and routing performance in real time.",
    badge: "Live monitoring",
  },
  scenarios: {
    kicker: "Call generator",
    title: "Test scenarios",
    description: "Build, edit, and run structured call-load scenarios against flows, queues, and agents.",
    badge: "Scenario management",
  },
  settings: {
    kicker: "Call generator",
    title: "Workspace settings",
    description: "Global defaults for concurrency, CPS caps, caller numbers, and safety rails.",
    badge: "Configuration",
  },
};

export default function AdminCallGeneratorPage() {
  const [activeSection, setActiveSection] = useState("dashboard");
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    try {
      const requested = new URLSearchParams(window.location.search).get("section");
      if (requested && CALL_GENERATOR_RAIL_ITEMS.some((item) => item.id === requested)) {
        setActiveSection(requested);
        return;
      }
      const saved = localStorage.getItem(CALL_GENERATOR_ACTIVE_SECTION_STORAGE_KEY);
      if (saved && CALL_GENERATOR_RAIL_ITEMS.some((item) => item.id === saved)) setActiveSection(saved);
    } catch {
      // storage access may fail in sandboxed frames
    }
  }, []);

  useEffect(() => {
    persistCallGeneratorSection(activeSection);
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("section") !== activeSection) {
        url.searchParams.set("section", activeSection);
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {}
  }, [activeSection]);

  const meta = SECTION_META[activeSection] || SECTION_META.dashboard;

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="Call Generator"
        badges={(
          <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
            {meta.badge}
          </Badge>
        )}
        actions={(
          <Button variant="outline" size="sm" onClick={() => setRefreshNonce((n) => n + 1)}>
            <IconRefresh className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        )}
      />
      <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}>
        <SectionRail
          items={CALL_GENERATOR_RAIL_ITEMS}
          activeId={activeSection}
          onSelect={setActiveSection}
          ariaLabel="Admin call generator sections"
        />
        <section className="h-full min-h-0 overflow-hidden pr-1">
          <Card className="flex h-full min-h-0 flex-col overflow-hidden">
            <CardContent className="flex-1 min-h-0 overflow-y-auto p-6">
              <div className="space-y-5">
                <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm dark:bg-zinc-950/70">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        {meta.kicker}
                      </div>
                      <h3 className="mt-2 text-xl font-semibold tracking-tight">{meta.title}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{meta.description}</p>
                    </div>
                  </div>
                </div>
                {activeSection === "dashboard" ? (
                  <CallGeneratorDashboardView refreshNonce={refreshNonce} />
                ) : activeSection === "scenarios" ? (
                  <CallGeneratorScenariosView refreshNonce={refreshNonce} />
                ) : (
                  <CallGeneratorSettingsView refreshNonce={refreshNonce} />
                )}
              </div>
            </CardContent>
          </Card>
        </section>
      </main>
    </AdminPageShell>
  );
}
