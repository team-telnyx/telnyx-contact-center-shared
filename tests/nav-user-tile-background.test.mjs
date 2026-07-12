import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navMain = readFileSync(
  new URL("../components/nav-main.jsx", import.meta.url),
  "utf8"
);
const navUser = readFileSync(
  new URL("../components/nav-user.jsx", import.meta.url),
  "utf8"
);

test("user profile card uses the same background as left navigation tiles", () => {
  assert.match(navMain, /bg-card\/70/);
  assert.match(navMain, /hover:bg-card/);
  assert.match(navUser, /bg-card\/70/);
  assert.match(navUser, /hover:bg-card/);
  assert.match(navUser, /data-\[state=open\]:bg-card/);
  assert.doesNotMatch(navUser, /bg-background\/55/);
});
