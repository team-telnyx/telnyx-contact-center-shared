// All standalone SLA badges share one clock; tables can supply their own now.
export function createInteractionClock({ now = Date.now, schedule = setInterval, cancel = clearInterval } = {}) {
  const listeners = new Set();
  let timer = null, snapshot = null;
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (timer === null) {
        snapshot = now();
        timer = schedule(() => {
          snapshot = now();
          for (const notify of listeners) notify();
        }, 1000);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer !== null) {
          cancel(timer);
          timer = null;
          snapshot = null;
        }
      };
    },
  };
}
export const interactionClock = createInteractionClock();
