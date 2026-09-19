import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const callHistorySourcePromise = readFile(
  new URL("../components/contact-center/SupervisorCallHistoryView.jsx", import.meta.url),
  "utf8",
);
const storeSourcePromise = readFile(
  new URL("../lib/stores/app-state-store.js", import.meta.url),
  "utf8",
);

test("supervisor call history date range is persisted in the app state store", async () => {
  const [callHistorySource, storeSource] = await Promise.all([
    callHistorySourcePromise,
    storeSourcePromise,
  ]);

  assert.match(
    callHistorySource,
    /useAppStateStore/,
    "Call History should read and update the app state store instead of keeping date range only in component state",
  );
  assert.match(
    storeSource,
    /supervisorCallHistoryDateRange/,
    "App state store should keep a supervisor Call History date range slice",
  );
  assert.match(
    storeSource,
    /setSupervisorCallHistoryDateRange/,
    "App state store should expose a setter for the supervisor Call History date range",
  );
  assert.match(
    storeSource,
    /name: "app-state-store"/,
    "App state store should persist via a stable localStorage key",
  );
  assert.match(
    storeSource,
    /partialize: \(state\) => \(\{[\s\S]*supervisorCallHistoryDateRange/s,
    "Persisted app state should include the supervisor Call History date range",
  );
});

test("supervisor history exposes shared date presets and persists changes with pagination reset", async () => {
  const callHistorySource = await callHistorySourcePromise;
  const toolbar = await readFile(new URL("../components/contact-center/AnalyticsReportFilters.jsx", import.meta.url), "utf8");
  assert.match(callHistorySource, /<AnalyticsReportFilters/);
  for (const [value, label] of [["1d", "1 day"], ["7d", "7 days"], ["30d", "30 days"], ["custom", "Custom"]]) {
    assert.ok(toolbar.includes(`["${value}", "${label}"]`));
  }
  assert.match(callHistorySource, /setQuickDateRange\(Number\(value.slice\(0, -1\)\)\)/);
  assert.match(callHistorySource, /quickCallHistoryDateRange\(days\)/);
  assert.match(callHistorySource, /setPage\(1\);[\s\S]*setSupervisorCallHistoryDateRange\(/);
});
