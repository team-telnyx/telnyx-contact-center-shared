import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
async function srcFile(path) { return readFile(join(root, path), "utf8"); }

describe("call generator code completeness", () => {
  it("schema contains cg_scenarios, cg_runs, cg_call_ledger", async () => {
    const code = await srcFile("lib/postgres-schema.mjs");
    assert.match(code, /cg_scenarios\s*\(/);
    assert.match(code, /cg_runs\s*\(/);
    assert.match(code, /cg_call_ledger\s*\(/);
  });

  it("menu includes Call Generator under ADMIN", async () => {
    const code = await srcFile("config/menu.jsx");
    assert.match(code, /Call Generator/);
    assert.match(code, /\/admin\/call-generator/);
  });

  it("page shell uses SectionRail with dashboard/scenarios/settings", async () => {
    const code = await srcFile("app/(portal)/admin/call-generator/page.jsx");
    assert.match(code, /SectionRail/);
    assert.match(code, /dashboard/);
    assert.match(code, /scenarios/);
    assert.match(code, /settings/);
    assert.match(code, /AdminPageShell/);
    assert.match(code, /AdminPageHeader/);
  });

  it("dashboard view fetches /api/admin/call-generator/runs", async () => {
    const code = await srcFile("components/contact-center/CallGeneratorDashboardView.jsx");
    assert.match(code, /\/api\/admin\/call-generator\/runs/);
  });

  it("scenarios view supports create, update, delete, start run", async () => {
    const code = await srcFile("components/contact-center/CallGeneratorScenariosView.jsx");
    assert.match(code, /\/api\/admin\/call-generator\/scenarios/);
    assert.match(code, /POST/);
    assert.match(code, /PUT/);
    assert.match(code, /DELETE/);
    assert.match(code, /\/api\/admin\/call-generator\/runs/);
  });

  it("settings view renders toggle and numeric inputs", async () => {
    const code = await srcFile("components/contact-center/CallGeneratorSettingsView.jsx");
    assert.match(code, /Switch/);
    assert.match(code, /Max concurrent|concurrent/i);
    assert.match(code, /CPS/i);
    assert.match(code, /whitelist/i);
  });

  it("API route for scenarios supports GET list and POST create", async () => {
    const code = await srcFile("app/api/admin/call-generator/scenarios/route.js");
    assert.match(code, /export async function GET/);
    assert.match(code, /export async function POST/);
    assert.match(code, /cg_scenarios/);
    assert.match(code, /requireAdmin/);
  });

  it("API route for scenario detail supports GET, PUT, DELETE", async () => {
    const code = await srcFile("app/api/admin/call-generator/scenarios/[id]/route.js");
    assert.match(code, /export async function GET/);
    assert.match(code, /export async function PUT/);
    assert.match(code, /export async function DELETE/);
  });

  it("API route for runs supports GET list and POST start", async () => {
    const code = await srcFile("app/api/admin/call-generator/runs/route.js");
    assert.match(code, /export async function GET/);
    assert.match(code, /export async function POST/);
    assert.match(code, /cg_runs/);
  });
});
