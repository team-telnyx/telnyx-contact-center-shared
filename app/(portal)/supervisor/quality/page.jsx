"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  IconChecklist,
  IconClipboardCheck,
  IconGauge,
  IconRefresh,
} from "@tabler/icons-react";
import {
  SupervisorPageHeader,
  SupervisorPageShell,
} from "@/components/contact-center/SupervisorPageLayout";
import {
  SectionRail,
  SECTION_RAIL_PAGE_GRID_CLASS,
  SECTION_RAIL_WIDTH,
} from "@/components/ui/section-rail";
import {
  QUALITY_ACTIVE_SECTION_STORAGE_KEY,
  QUALITY_RAIL_ITEMS,
  persistQualitySection,
} from "@/components/contact-center/QualitySectionNav";
import QualityDashboardView from "@/components/contact-center/QualityDashboardView";
import QualityEvaluationsView from "@/components/contact-center/QualityEvaluationsView";
import QualityFormsView from "@/components/contact-center/QualityFormsView";

const neutralActionClass =
  "bg-zinc-950 text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";

function toLocalDateTimeInput(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function quickQualityDateRange(days) {
  const safeDays = Math.max(1, Number(days) || 1);
  const from = new Date();
  from.setDate(from.getDate() - (safeDays - 1));
  from.setHours(0, 0, 0, 0);
  const to = new Date();
  to.setHours(23, 59, 0, 0);
  return {
    from: toLocalDateTimeInput(from),
    to: toLocalDateTimeInput(to),
  };
}

function toIsoDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

const SECTION_META = {
  dashboard: {
    kicker: "Quality dashboard",
    title: "Quality scores and evaluation activity",
    description: "Average scores, AI vs human evaluations, and quality trends across agents, queues, and forms.",
    icon: IconGauge,
  },
  evaluations: {
    kicker: "Evaluations",
    title: "Conversations to review and score",
    description: "Pick a recorded conversation, listen to it, and score it manually or with the AI assistant.",
    icon: IconChecklist,
  },
  forms: {
    kicker: "Evaluation forms",
    title: "Quality scorecards and templates",
    description: "Build evaluation forms with weighted criteria and AI rubrics. Ready-made templates are seeded for you.",
    icon: IconClipboardCheck,
  },
};

function CommandCard({ icon: Icon, kicker, title, description, controls }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm dark:bg-zinc-950/70">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <Icon className="h-4 w-4 text-telnyx-green" />
            {kicker}
          </div>
          <h3 className="mt-2 text-xl font-semibold tracking-tight">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {controls}
      </div>
    </div>
  );
}

export default function SupervisorQualityPage() {
  const [activeSection, setActiveSection] = useState("evaluations");
  const [range, setRange] = useState("7d");
  const [dateRange, setDateRange] = useState(() => quickQualityDateRange(7));
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    try {
      const requested = new URLSearchParams(window.location.search).get("section");
      if (requested && QUALITY_RAIL_ITEMS.some((item) => item.id === requested)) {
        setActiveSection(requested);
        return;
      }
      const saved = localStorage.getItem(QUALITY_ACTIVE_SECTION_STORAGE_KEY);
      if (saved && QUALITY_RAIL_ITEMS.some((item) => item.id === saved)) setActiveSection(saved);
    } catch {
      // Ignore storage errors so the quality page still works without persisted UI state.
    }
  }, []);

  useEffect(() => {
    persistQualitySection(activeSection);
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("section") !== activeSection) {
        url.searchParams.set("section", activeSection);
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {}
  }, [activeSection]);

  const fromIso = useMemo(() => toIsoDateTime(dateRange.from), [dateRange.from]);
  const toIso = useMemo(() => toIsoDateTime(dateRange.to), [dateRange.to]);

  const setQuickRange = (days) => {
    setRange(`${days}d`);
    setDateRange(quickQualityDateRange(days));
  };

  const meta = SECTION_META[activeSection] || SECTION_META.evaluations;
  const showDateControls = activeSection !== "forms";

  const commandControls = showDateControls ? (
    <div className="flex flex-wrap items-end justify-start gap-3 xl:justify-end" data-testid="quality-command-card-controls">
      <div className="flex rounded-xl border bg-muted/40 p-1">
        <Button type="button" size="sm" variant={range === "1d" ? "default" : "ghost"} className={range === "1d" ? neutralActionClass : ""} onClick={() => setQuickRange(1)}>1 day</Button>
        <Button type="button" size="sm" variant={range === "7d" ? "default" : "ghost"} className={range === "7d" ? neutralActionClass : ""} onClick={() => setQuickRange(7)}>7 days</Button>
        <Button type="button" size="sm" variant={range === "30d" ? "default" : "ghost"} className={range === "30d" ? neutralActionClass : ""} onClick={() => setQuickRange(30)}>30 days</Button>
        <Button type="button" size="sm" variant={range === "custom" ? "default" : "ghost"} className={range === "custom" ? neutralActionClass : ""} onClick={() => setRange("custom")}>Custom range</Button>
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">From</div>
        <Input type="datetime-local" value={dateRange.from} onChange={(event) => { setRange("custom"); setDateRange((prev) => ({ ...prev, from: event.target.value })); }} className="w-[190px] bg-transparent dark:bg-input/30 dark:hover:bg-input/50" />
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">To</div>
        <Input type="datetime-local" value={dateRange.to} onChange={(event) => { setRange("custom"); setDateRange((prev) => ({ ...prev, to: event.target.value })); }} className="w-[190px] bg-transparent dark:bg-input/30 dark:hover:bg-input/50" />
      </div>
    </div>
  ) : null;

  return (
    <SupervisorPageShell>
      <SupervisorPageHeader
        title="Quality"
        badges={(
          <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            Quality management
          </Badge>
        )}
        actions={(
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRefreshNonce((nonce) => nonce + 1)}
          >
            <IconRefresh className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        )}
      />
      <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}>
        <SectionRail items={QUALITY_RAIL_ITEMS} activeId={activeSection} onSelect={setActiveSection} ariaLabel="Supervisor quality management sections" />
        <section className="h-full min-h-0 overflow-hidden pr-1">
          <Card className="flex h-full min-h-0 flex-col overflow-hidden">
            <CardContent className="flex-1 min-h-0 overflow-y-auto p-6">
              <div className="space-y-5">
                <CommandCard icon={meta.icon} kicker={meta.kicker} title={meta.title} description={meta.description} controls={commandControls} />
                {activeSection === "dashboard" ? (
                  <QualityDashboardView from={fromIso} to={toIso} refreshNonce={refreshNonce} />
                ) : activeSection === "forms" ? (
                  <QualityFormsView refreshNonce={refreshNonce} />
                ) : (
                  <QualityEvaluationsView from={fromIso} to={toIso} refreshNonce={refreshNonce} />
                )}
              </div>
            </CardContent>
          </Card>
        </section>
      </main>
    </SupervisorPageShell>
  );
}
