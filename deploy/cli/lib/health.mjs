// Polls a health endpoint until it reports healthy or a timeout elapses.
// Used both by the Local target (after `docker compose up -d`) and, in Phase 4,
// the cloud path (after Terraform apply + cloud-init finishes).

export async function waitForHealthy({
  url,
  timeoutMs = 120_000,
  intervalMs = 2000,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onAttempt,
} = {}) {
  if (!url) throw new Error('waitForHealthy requires a url');
  const start = now();
  let lastError = null;
  let attempts = 0;

  while (now() - start < timeoutMs) {
    attempts += 1;
    try {
      const res = await fetchImpl(url, { method: 'GET' });
      const elapsedMs = now() - start;
      if (res.ok) {
        let body = null;
        try {
          body = await res.json();
        } catch {
          // non-JSON body still counts as reachable+ok; healthy flag left null
        }
        const healthy = body ? body.status === 'healthy' : true;
        if (onAttempt) onAttempt({ attempt: attempts, ok: res.ok, healthy, elapsedMs, body });
        if (healthy) {
          return { healthy: true, attempts, elapsedMs, body };
        }
        lastError = new Error(`Health endpoint reachable but not healthy yet: ${JSON.stringify(body)}`);
      } else {
        lastError = new Error(`Health endpoint returned HTTP ${res.status}`);
        if (onAttempt) onAttempt({ attempt: attempts, ok: false, healthy: false, elapsedMs, error: lastError });
      }
    } catch (err) {
      lastError = err;
      const elapsedMs = now() - start;
      if (onAttempt) onAttempt({ attempt: attempts, ok: false, healthy: false, elapsedMs, error: err });
    }
    await sleep(intervalMs);
  }

  return {
    healthy: false,
    attempts,
    elapsedMs: now() - start,
    error: lastError,
  };
}
