import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("HA sample env documents multi-node runtime flags with safe single-node defaults", async () => {
  const sample = await source("sample.env");

  assert.match(sample, /PROCESS_ROLE=all/);
  assert.match(sample, /# PROCESS_ROLE=web/);
  assert.match(sample, /# PROCESS_ROLE=streaming/);
  assert.match(sample, /# PROCESS_ROLE=worker/);
  assert.match(sample, /EVENT_BUS=pg/);
  assert.match(sample, /SSE_FANOUT=false/);
  assert.match(sample, /GLOBAL_PRESENCE=false/);
  assert.match(sample, /GLOBAL_PRESENCE_TTL_MS=90000/);
  assert.match(sample, /ROUTING_EVENT_DRIVEN=false/);
  assert.match(sample, /COORDINATOR_SINGLETON=false/);
  assert.match(sample, /OUTBOUND_POWER_PACING=false/);
  assert.match(sample, /OUTBOUND_PREDICTIVE_PACING=false/);
});

test("README-HA has an explicit HA runtime flag matrix and role split guidance", async () => {
  const readme = await source("README-HA.md");

  assert.match(readme, /## HA Runtime Flags/);
  assert.match(readme, /\| `PROCESS_ROLE` \| `all` \|/);
  assert.match(readme, /\| `SSE_FANOUT` \| `false` \|/);
  assert.match(readme, /\| `GLOBAL_PRESENCE` \| `false` \|/);
  assert.match(readme, /\| `EVENT_BUS` \| `pg` \|/);
  assert.match(readme, /\| `OUTBOUND_POWER_PACING` \| `false` \|/);
  assert.match(readme, /\| `OUTBOUND_PREDICTIVE_PACING` \| `false` \|/);
  assert.match(readme, /`PROCESS_ROLE=web`/);
  assert.match(readme, /`PROCESS_ROLE=streaming`/);
  assert.match(readme, /`PROCESS_ROLE=worker`/);
  assert.match(readme, /cc-ha-ws\.demotelnyx\.com/);
});
