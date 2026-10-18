import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

for (const script of ["review-catalog", "verify-review"]) {
  test(`${script} reports counts without printing environment values or provider error text`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "cc-review-output-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "messages"));
    await mkdir(join(cwd, "output"));
    await writeFile(join(cwd, "messages/source.json"), JSON.stringify({ sample: { source: "Test", files: ["app/page.jsx"] } }));
    await writeFile(join(cwd, "messages/glossary.json"), JSON.stringify({ locales: ["pl-PL"], entries: [] }));
    await writeFile(join(cwd, "messages/pl-PL.json"), JSON.stringify({ ui: { sample: "Test" } }));
    await writeFile(join(cwd, "output/pl-PL-000-fixture.json"), JSON.stringify({ locale: "pl-PL", issues: [{ id: "sample", translation: "Old", replacement: "New" }] }));
    await writeFile(join(cwd, "fetch.mjs"), `globalThis.fetch = async () => { throw new Error("PROVIDER_PRIVATE_DETAIL"); };`);
    const result = spawnSync(process.execPath, ["--import", join(cwd, "fetch.mjs"), fileURLToPath(new URL(`../scripts/i18n/${script}.mjs`, import.meta.url)), "pl-PL"], {
      cwd, encoding: "utf8", env: { PATH: process.env.PATH, I18N_REVIEW_OUTPUT: join(cwd, "output"), I18N_REVIEW_MODEL: "PRIVATE_MODEL_VALUE", I18N_VERIFY_MODEL: "PRIVATE_MODEL_VALUE", TELNYX_API_KEY: "PRIVATE_API_KEY_VALUE" },
    });
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    for (const value of ["PRIVATE_MODEL_VALUE", "PRIVATE_API_KEY_VALUE", "PROVIDER_PRIVATE_DETAIL"]) assert(!output.includes(value));
    assert.match(result.stdout, /"failedBatches":1/);
  });
}
