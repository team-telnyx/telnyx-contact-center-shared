import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

// ── Menu ──────────────────────────────────────────────────────────────────────

test("Quality menu item lives in the SUPERVISOR group with supervisor access", () => {
  const menu = read("config/menu.jsx");
  const supervisorSlice = menu.slice(
    menu.indexOf('label: "SUPERVISOR"'),
    menu.indexOf('label: "ADMIN"'),
  );
  assert.match(
    supervisorSlice,
    /title:\s*"Quality",[\s\S]*?url:\s*"\/supervisor\/quality",[\s\S]*?role_access:\s*\["supervisor",\s*"admin",\s*"owner"\]/,
    "Quality sidebar item should be in the SUPERVISOR group for supervisor/admin/owner",
  );
});

// ── Section rail nav ──────────────────────────────────────────────────────────

test("Quality section rail exposes dashboard, evaluations, and forms sections", () => {
  const nav = read("components/contact-center/QualitySectionNav.jsx");
  assert.match(nav, /QUALITY_ACTIVE_SECTION_STORAGE_KEY\s*=\s*\n?\s*"supervisor\.quality\.activeSection"/);
  for (const id of ["dashboard", "evaluations", "forms"]) {
    assert.match(nav, new RegExp(`id:\\s*"${id}"`), `rail should include section "${id}"`);
  }
  assert.match(nav, /persistQualitySection/);
  assert.match(nav, /router\.push\(`\/supervisor\/quality\?section=\$\{encodeURIComponent\(sectionId\)\}`\)/);
});

test("Quality page hydrates section from URL param and localStorage like analytics", () => {
  const page = read("app/(portal)/supervisor/quality/page.jsx");
  assert.match(page, /new URLSearchParams\(window\.location\.search\)\.get\("section"\)/);
  assert.match(page, /localStorage\.getItem\(QUALITY_ACTIVE_SECTION_STORAGE_KEY\)/);
  assert.match(page, /QUALITY_RAIL_ITEMS\.some\(\(item\) => item\.id === /);
  assert.match(page, /window\.history\.replaceState/);
  assert.match(page, /persistQualitySection\(activeSection\)/);
});

test("Quality page reuses the supervisor workspace layout and command card design", () => {
  const page = read("app/(portal)/supervisor/quality/page.jsx");
  assert.match(page, /SupervisorPageShell/);
  assert.match(page, /SupervisorPageHeader/);
  assert.match(page, /SECTION_RAIL_PAGE_GRID_CLASS/);
  assert.match(page, /SECTION_RAIL_WIDTH/);
  assert.match(page, /rounded-2xl border border-border\/70 bg-card p-4 shadow-sm dark:bg-zinc-950\/70/);
  assert.match(page, /data-testid="quality-command-card-controls"/);
  assert.match(page, /tracking-\[0\.18em\]/);
  // Quick-range buttons like analytics
  for (const label of ["1 day", "7 days", "30 days", "Custom range"]) {
    assert.match(page, new RegExp(label), `command card should expose "${label}" quick range`);
  }
  assert.match(page, /datetime-local/);
});

// ── DB schema separation ──────────────────────────────────────────────────────

test("Quality tables are separate from the scripting form_* tables", () => {
  const schema = read("lib/postgres-schema.mjs");
  for (const table of [
    "quality_forms",
    "quality_form_versions",
    "quality_evaluations",
    "quality_ai_jobs",
  ]) {
    assert.match(
      schema,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`),
      `schema should create ${table}`,
    );
  }
  // Evaluations reference quality_forms, never the scripting form_definitions.
  const evaluationBlock = schema.slice(
    schema.indexOf("CREATE TABLE IF NOT EXISTS quality_evaluations"),
    schema.indexOf("CREATE TABLE IF NOT EXISTS quality_ai_jobs"),
  );
  assert.match(evaluationBlock, /REFERENCES quality_forms\(id\)/);
  assert.doesNotMatch(evaluationBlock, /form_definitions/);
  // Seeding is wired in.
  assert.match(schema, /seed-quality-forms\.mjs/);
});

test("Quality form seed provides five published templates", () => {
  const seed = read("lib/seed-quality-forms.mjs");
  for (const slug of [
    "customer-service-quality-scorecard",
    "compliance-qa-checklist",
    "sales-conversation-scorecard",
    "technical-support-qa",
    "ai-handoff-evaluation",
  ]) {
    assert.match(seed, new RegExp(`slug:\\s*"${slug}"`), `seed should include ${slug}`);
  }
  assert.match(seed, /INSERT INTO quality_forms/);
  assert.match(seed, /INSERT INTO quality_form_versions/);
  assert.doesNotMatch(seed, /form_definitions/, "seed must not touch scripting forms tables");
});

// ── API routes ────────────────────────────────────────────────────────────────

test("Quality API routes are supervisor/admin guarded", () => {
  for (const route of [
    "app/api/contact-center/quality/forms/route.js",
    "app/api/contact-center/quality/forms/[id]/route.js",
    "app/api/contact-center/quality/evaluations/route.js",
    "app/api/contact-center/quality/evaluations/[id]/route.js",
    "app/api/contact-center/quality/evaluations/[id]/ai/route.js",
    "app/api/contact-center/quality/dashboard/route.js",
  ]) {
    const source = read(route);
    assert.match(source, /getAuthenticatedUser/, `${route} should authenticate`);
    assert.match(source, /isSupervisorOrAdmin/, `${route} should be supervisor/admin only`);
  }
});

test("Quality evaluations API uses transfer-leg hygiene and clamped range", () => {
  const source = read("app/api/contact-center/quality/evaluations/route.js");
  assert.match(source, /is_transfer_leg/);
  assert.match(source, /is_consult_call/);
  assert.match(source, /MAX_RANGE_DAYS = 92/);
});

test("AI evaluation pipeline transcribes when needed and stores an auditable draft", () => {
  const route = read("app/api/contact-center/quality/evaluations/[id]/ai/route.js");
  assert.match(route, /getExistingTranscript/);
  assert.match(route, /transcribeInteractionRecording/);
  assert.match(route, /evaluateTranscriptWithAi/);
  assert.match(route, /'ai_draft'/);
  assert.match(route, /quality_ai_jobs/);

  const evaluator = read("lib/quality/ai-evaluator.mjs");
  assert.match(evaluator, /reasoning/);
  assert.match(evaluator, /evidence/);
  assert.match(evaluator, /confidence/);

  const transcription = read("lib/quality/transcription.mjs");
  assert.match(transcription, /\/ai\/audio\/transcriptions/);
  assert.match(transcription, /transcription_text/);
});

// ── Evaluation detail page ────────────────────────────────────────────────────

test("Evaluation detail page reuses RecordingPlayer and exposes the AI button", () => {
  const page = read("app/(portal)/supervisor/quality/evaluations/[id]/page.jsx");
  assert.match(page, /import RecordingPlayer from "@\/components\/contact-center\/RecordingPlayer"/);
  assert.match(page, /QualitySectionRailNav activeId="evaluations"/);
  assert.match(page, /data-testid="evaluate-with-ai-button"/);
  assert.match(page, /Evaluate with AI/);
  assert.match(page, /Finalize/);
  assert.match(page, /Transcribing recording…/);
  assert.match(page, /Scoring the form…/);
});

test("Evaluation detail cards use the workspace card background (no near-black zinc)", () => {
  const page = read("app/(portal)/supervisor/quality/evaluations/[id]/page.jsx");
  assert.match(page, /border-border\/70 bg-card\/95 shadow-sm/);
  assert.doesNotMatch(
    page,
    /dark:bg-zinc-950\/70/,
    "detail cards must match the rail/list card background, not dark zinc",
  );
});

test("Evaluation detail columns scroll independently on xl screens", () => {
  const page = read("app/(portal)/supervisor/quality/evaluations/[id]/page.jsx");
  assert.match(
    page,
    /<section className="h-full min-h-0 overflow-y-auto pr-1 xl:overflow-hidden">/,
    "outer section must not scroll on xl so columns own their scrollbars",
  );
  assert.match(page, /grid h-full min-h-0 gap-4 xl:grid-cols-\[minmax\(0,1fr\)_420px\]/);
  const columnScrolls = page.match(/min-h-0 space-y-4 xl:overflow-y-auto xl:pr-1/g) || [];
  assert.equal(columnScrolls.length, 2, "both columns must scroll independently on xl");
});

test("Quality form editor sheet keeps static header/footer with scrollable body (Users sheet pattern)", () => {
  const view = read("components/contact-center/QualityFormsView.jsx");
  assert.match(view, /SheetFooter/);
  assert.match(
    view,
    /<SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:max-w-2xl">/,
    "sheet content must be a non-scrolling flex column",
  );
  assert.match(view, /<SheetHeader className="border-b px-6 py-4">/);
  assert.match(view, /<div className="flex-1 overflow-y-auto">/, "only the body scrolls");
  assert.match(view, /<SheetFooter className="flex flex-row justify-end gap-2 border-t px-6 py-4">/);
});

test("Evaluations list paginates like Call History (rows-per-page select, default 10)", () => {
  const view = read("components/contact-center/QualityEvaluationsView.jsx");
  assert.match(view, /useState\(10\)/, "default page size must be 10");
  assert.match(view, /data-testid="quality-evaluations-pagination"/);
  assert.match(view, /Page \{page\} of \{totalPages\}/);
  assert.match(view, /Rows per page/);
  assert.match(view, /\[10, 25, 50, 100\]\.map/, "page size options must match Call History");
  // Same rounded icon-button pager as SupervisorCallHistoryView (first/prev/next/last)
  for (const icon of ["IconChevronsLeft", "IconChevronLeft", "IconChevronRight", "IconChevronsRight"]) {
    assert.match(view, new RegExp(`<${icon} className="h-4 w-4" />`), `pager must use ${icon}`);
  }
  assert.match(view, /setPage\(1\)} disabled=\{page === 1\} className="rounded-full"/);
  assert.match(view, /setPage\(totalPages\)} disabled=\{page === totalPages\} className="rounded-full"/);
  assert.match(view, /SelectTrigger className="w-\[110px\] rounded-full px-4"/);
  // Changing page size resets to the first page.
  assert.match(view, /onValueChange=\{\(value\) => \{ setPage\(1\); setPageSize\(Number\(value\)\); \}\}/);
});

test("Quality views keep the entrenched metric tile design language", () => {
  for (const view of [
    "components/contact-center/QualityDashboardView.jsx",
    "components/contact-center/QualityEvaluationsView.jsx",
  ]) {
    const source = read(view);
    assert.match(source, /rounded-2xl bg-gradient-to-br p-3/, `${view} metric tiles should match analytics style`);
    assert.match(source, /hover:-translate-y-0\.5/, `${view} cards should keep hover lift`);
  }
  const dashboard = read("components/contact-center/QualityDashboardView.jsx");
  assert.match(dashboard, /ChartTooltip/, "dashboard charts must use the shared dark tooltip");
  assert.doesNotMatch(dashboard, /<Tooltip \/>/, "bare recharts Tooltip is forbidden");
});
