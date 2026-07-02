import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url),
  "utf8",
);

const dashboardMonitorPanel = source.slice(
  source.indexOf("function DashboardMonitorPanel"),
  source.indexOf("function MappingEditor"),
);

test("campaign monitor keeps summary stats static while only latest attempts scroll", () => {
  assert.doesNotMatch(
    dashboardMonitorPanel,
    /\n\s*return <div className="[^"]*overflow-y-auto[^"]*"/,
    "DashboardMonitorPanel main rendered root should not make the whole Campaign monitor card scroll",
  );

  assert.match(
    dashboardMonitorPanel,
    /Latest call attempts[\s\S]*?className="[^"]*max-h-\[[^\]]+\][^"]*overflow-y-auto[^"]*"/,
    "Latest call attempts list should own a bounded vertical scroll area",
  );
});
