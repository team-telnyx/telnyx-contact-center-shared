/** Recheck long-lived authorization before forwarding data and while idle. */
export function guardEventStream(response, { authorize, abort, signal, subscribe, intervalMs = 3000 }) {
  const reader = response.body.getReader();
  let stop;
  const body = new ReadableStream({
    start(controller) {
      let closed = false;
      let pending = null;
      let unsubscribe;
      let timer;
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe?.();
        signal?.removeEventListener('abort', stop);
        abort?.();
        reader.cancel().catch(() => {});
        try { controller.close(); } catch {}
      };
      const check = () => {
        if (closed) return Promise.resolve(false);
        if (!pending) pending = Promise.resolve().then(authorize).catch(() => false).finally(() => { pending = null; });
        return pending;
      };
      unsubscribe = subscribe?.(() => {
        if (!closed) controller.enqueue(new TextEncoder().encode('event: authz_changed\ndata: {}\n\n'));
        stop();
      });
      timer = setInterval(async () => { if (!await check()) stop(); }, intervalMs);
      timer.unref?.();
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) { stop(); return; }
      (async () => {
        try {
          while (!closed) {
            const chunk = await reader.read();
            if (chunk.done || !await check()) break;
            if (!closed) controller.enqueue(chunk.value);
          }
        } finally { stop(); }
      })().catch(stop);
    },
    cancel() { stop?.(); },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}
