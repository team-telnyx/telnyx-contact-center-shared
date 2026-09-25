// The launcher (deploy/cc) gates on the Node version before installing or
// launching, because npm does not enforce "engines" unless engine-strict is on
// and it is off by default. That gate is a hand-written expression in a shell
// script, so nothing but this test keeps it in step with the manifest it is
// supposed to mirror.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = readFileSync(path.join(here, "..", "..", "cc"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));

test("the launcher advertises the same Node range as the manifest", () => {
  const declared = manifest.engines?.node;
  assert.ok(declared, "deploy/cli/package.json must declare engines.node");
  assert.ok(
    shim.includes(`NODE_RANGE="${declared}"`),
    `deploy/cc must carry NODE_RANGE="${declared}" so the two cannot drift apart`,
  );
});

test("the launcher's gate accepts exactly the advertised versions", () => {
  const gate = shim.match(/node -e '([^']+)'/);
  assert.ok(gate, "deploy/cc must gate on a `node -e` expression");

  const accepts = (version) => {
    let code = 0;
    // eslint-disable-next-line no-new-func -- the gate under test is source, not input
    new Function("process", gate[1])({ versions: { node: version }, exit: (value) => { code = value; } });
    return code === 0;
  };

  // @inquirer/prompts declares >=23.5.0 || ^22.13.0 || ^20.17.0, and chalk 6
  // needs >=22, so the 20 line is out and the two gaps below are real.
  for (const version of ["22.13.0", "22.22.3", "23.5.0", "23.9.1", "24.0.0", "30.1.2"]) {
    assert.equal(accepts(version), true, `Node ${version} should be accepted`);
  }
  for (const version of ["18.20.4", "20.17.0", "20.19.4", "22.0.0", "22.12.9", "23.0.0", "23.4.9"]) {
    assert.equal(accepts(version), false, `Node ${version} should be rejected`);
  }
});
