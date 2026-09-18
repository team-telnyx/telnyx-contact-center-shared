"use client";
import { useEffect, useState } from 'react';

// Queue inventory is independent of report dates, channel and selection. Skills
// supply and active AI handoffs must remain filterable without terminal history.
export function useAnalyticsQueueOptions(refreshNonce) {
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    async function load() {
      try {
        const response = await fetch('/api/contact-center/analytics/queues', { cache: 'no-store', signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error || 'Unable to load queue options');
        if (!controller.signal.aborted) setSnapshot({ refreshNonce, queues: payload?.queues || [], error: null });
      } catch (error) {
        if (!controller.signal.aborted) setSnapshot({ refreshNonce, queues: [], error: 'Unable to load queue options. Use Refresh to retry.' });
      }
    }
    load();
    return () => controller.abort();
  }, [refreshNonce]);
  const current = snapshot?.refreshNonce === refreshNonce ? snapshot : null;
  return { queues: current?.queues || [], loading: !current, error: current?.error || null };
}
