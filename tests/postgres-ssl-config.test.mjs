import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("PGSSLMODE TLS-required modes enable SSL without certificate verification", () => {
  for (const sslMode of ["require", "no-verify"]) {
    assert.deepEqual(readPostgresSslConfig({ PGSSLMODE: sslMode }), {
      rejectUnauthorized: false,
    });
  }
});

test("PGSSLMODE opportunistic modes do not force TLS without fallback support", () => {
  for (const sslMode of ["allow", "prefer"]) {
    assert.equal(readPostgresSslConfig({ PGSSLMODE: sslMode }), false);
  }
});

test("explicit Postgres SSL enables TLS even with opportunistic sslmodes", () => {
  assert.deepEqual(readPostgresSslConfig({ PGSSLMODE: "prefer", POSTGRES_SSL: "true" }), {
    rejectUnauthorized: false,
  });
});

test("PGSSLMODE verify modes load configured TLS files", () => {
  const dir = mkdtempSync(join(tmpdir(), "postgres-ssl-config-"));
  const rootCert = join(dir, "root.crt");
  const clientCert = join(dir, "client.crt");
  const clientKey = join(dir, "client.key");

  writeFileSync(rootCert, "ca-cert");
  writeFileSync(clientCert, "client-cert");
  writeFileSync(clientKey, "client-key");

  assert.deepEqual(
    readPostgresSslConfig({
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: rootCert,
      PGSSLCERT: clientCert,
      PGSSLKEY: clientKey,
    }),
    {
      rejectUnauthorized: true,
      ca: "ca-cert",
      cert: "client-cert",
      key: "client-key",
    },
  );
});
