import { randomUUID } from "crypto";
import { getPostgresPool } from "../postgres.mjs";

const runtime = (globalThis.__cc_coordinator_runtime ||= {
  ownerId: `${process.pid || "node"}-${randomUUID()}`,
});

function resolvePool(pool) {
  return pool || getPostgresPool();
}

export function getCoordinatorOwnerId() {
  return runtime.ownerId;
}

export async function tryAcquireCoordinatorLease(leaseName, ttlMs, opts = {}) {
  if (!leaseName) {
    throw new Error("leaseName is required");
  }

  const pool = resolvePool(opts.pool);
  if (!pool) {
    return false;
  }

  const ownerId = opts.ownerId || runtime.ownerId;
  const normalizedTtlMs = Number.isFinite(Number(ttlMs))
    ? Math.max(1, Math.trunc(Number(ttlMs)))
    : 10_000;

  const result = await pool.query(
    `INSERT INTO cc_coordinator_leases (lease_name, owner_id, lease_expires_at, updated_at)
     VALUES ($1, $2, now() + ($3::text || ' milliseconds')::interval, now())
     ON CONFLICT (lease_name) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           lease_expires_at = EXCLUDED.lease_expires_at,
           updated_at = now()
       WHERE cc_coordinator_leases.lease_expires_at < now()
          OR cc_coordinator_leases.owner_id = EXCLUDED.owner_id
     RETURNING lease_name`,
    [leaseName, ownerId, normalizedTtlMs],
  );

  return (result.rows || []).length > 0;
}

export async function runWithCoordinatorLease(leaseName, ttlMs, fn, opts = {}) {
  const acquired = await tryAcquireCoordinatorLease(leaseName, ttlMs, opts);
  if (!acquired) {
    return { acquired: false, skipped: true };
  }

  const result = await fn();
  return { acquired: true, result };
}
