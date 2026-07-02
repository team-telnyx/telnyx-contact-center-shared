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

test("supervisor call history exposes quick date range buttons", async () => {
  const callHistorySource = await callHistorySourcePromise;

  for (const label of ["1 day", "7 days", "30 days"]) {
    assert.match(
      callHistorySource,
      new RegExp(`>${label}<`),
      `Call History should render a ${label} quick range button`,
    );
  }

  assert.match(
    callHistorySource,
    /setQuickDateRange\(1\)/,
    "1 day quick range should set a one-day range",
  );
  assert.match(
    callHistorySource,
    /setQuickDateRange\(7\)/,
    "7 days quick range should set a seven-day range",
  );
  assert.match(
    callHistorySource,
    /setQuickDateRange\(30\)/,
    "30 days quick range should set a thirty-day range",
  );
  assert.match(
    callHistorySource,
    /setPage\(1\);[\s\S]*setSupervisorCallHistoryDateRange\(/,
    "Quick range changes should reset pagination and save the date range in app state",
  );
});
