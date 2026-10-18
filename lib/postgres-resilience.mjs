import { Client, Pool } from "pg";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function postgresResilienceOptions(env = process.env) {
  return {
    // A server-side statement timeout cannot help when its response is lost.
    query_timeout: positiveInt(env.POSTGRES_QUERY_TIMEOUT_MS, 35000),
    keepAlive: true,
    keepAliveInitialDelayMillis: positiveInt(env.POSTGRES_KEEPALIVE_DELAY_MS, 10000),
    maxLifetimeSeconds: positiveInt(env.POSTGRES_MAX_LIFETIME_SECONDS, 300),
  };
}

export function isPostgresConnectionFailure(error) {
  const code = String(error?.code || "");
  return code.startsWith("08") ||
    ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "57P01", "57P02", "57P03", "PG_QUERY_DEADLINE"].includes(code) ||
    /Query read timeout|Connection terminated|connection error and is not queryable/i.test(error?.message || "");
}

function disconnect(client) {
  // pg.Client.end force-closes a socket with an active query. Do not wait for
  // that query (or attempt ROLLBACK on it) before releasing the pool slot.
  client.end().catch(() => {});
}

export class FailoverSafePostgresClient extends Client {
  query(...args) {
    const discardOnFailure = (error) => {
      if (isPostgresConnectionFailure(error)) disconnect(this);
    };
    const wrapCallback = (callback) => {
      let completed = false;
      return (error, result) => {
        if (completed) return;
        completed = true;
        discardOnFailure(error);
        callback(error, result);
      };
    };
    const last = args.length - 1;
    if (typeof args[last] === "function") {
      args[last] = wrapCallback(args[last]);
    } else if (typeof args[0]?.callback === "function") {
      const config = args[0];
      // Preserve the prototype of pg.Query/custom Submittables.
      if (typeof config.submit === "function") config.callback = wrapCallback(config.callback);
      else args[0] = { ...config, callback: wrapCallback(config.callback) };
    }
    const result = super.query(...args);
    if (typeof result?.catch === "function") {
      return result.catch((error) => {
        discardOnFailure(error);
        throw error;
      });
    }
    if (typeof result?.once === "function") result.once("error", discardOnFailure);
    return result;
  }
}

export function createPostgresPool(options) {
  return new Pool({ ...postgresResilienceOptions(), ...options, Client: FailoverSafePostgresClient });
}

export async function queryPostgresWithDeadline(pool, query, timeoutMillis) {
  const timeout = positiveInt(timeoutMillis, 5000);
  const deadlineAt = Date.now() + timeout;
  const timeoutError = Object.assign(new Error("Database query timeout"), { code: "PG_QUERY_DEADLINE" });
  let expired = false;
  let client;
  let failure;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(timeoutError);
    }, timeout);
  });
  try {
    const acquisition = pool.connect().then((acquired) => {
      // A timed-out acquisition may succeed later. It must not leak a client
      // or issue the abandoned query after the HTTP request has finished.
      if (expired) {
        acquired.release();
        return null;
      }
      return acquired;
    });
    client = await Promise.race([acquisition, deadline]);
    const remaining = Math.max(1, deadlineAt - Date.now());
    return await Promise.race([
      client.query({ ...query, query_timeout: remaining }),
      deadline,
    ]);
  } catch (error) {
    failure = error;
    if (client && isPostgresConnectionFailure(error)) disconnect(client);
    throw error;
  } finally {
    clearTimeout(timer);
    if (client) client.release(failure);
  }
}
