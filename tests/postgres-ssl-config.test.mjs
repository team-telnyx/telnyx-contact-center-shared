import assert from "node:assert/strict";
import test from "node:test";

import { readPostgresSslConfig } from "../lib/postgres-ssl.mjs";

test("Postgres SSL remains disabled by default for single-node/local deployments", () => {
  assert.equal(readPostgresSslConfig({}), false);
});

test("Postgres SSL is enabled for RDS-style sslmode=require", () => {
  assert.deepEqual(readPostgresSslConfig({ PGSSLMODE: "require" }), {
    rejectUnauthorized: false,
  });
});

test("Postgres SSL can require certificate validation explicitly", () => {
  assert.deepEqual(
    readPostgresSslConfig({ POSTGRES_SSL: "true", POSTGRES_SSL_REJECT_UNAUTHORIZED: "true" }),
    { rejectUnauthorized: true },
  );
});

test("Postgres SSL disable mode overrides broad environment defaults", () => {
  assert.equal(readPostgresSslConfig({ PGSSLMODE: "disable", POSTGRES_SSL: "true" }), false);
});

test("DATABASE_SSL=false explicitly disables SSL", () => {
  assert.equal(readPostgresSslConfig({ DATABASE_SSL: "false", PGSSLMODE: "require" }), false);
});

test("POSTGRES_SSL=false explicitly disables SSL", () => {
  assert.equal(readPostgresSslConfig({ POSTGRES_SSL: "false", PGSSLMODE: "verify-full" }), false);
});

test("PGSSLMODE verify modes validate certificates by default", () => {
  assert.deepEqual(readPostgresSslConfig({ PGSSLMODE: "verify-full" }), {
    rejectUnauthorized: true,
  });
  assert.deepEqual(readPostgresSslConfig({ PGSSLMODE: "verify-ca" }), {
    rejectUnauthorized: true,
  });
});
