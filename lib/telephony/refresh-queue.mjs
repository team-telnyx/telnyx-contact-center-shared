// Collapse a burst of invalidations while ensuring an event received during a
// GET causes another GET. Responses cannot overwrite a newer snapshot out of order.
export function coalesceRefresh(read) {
  let running = null, again = false;
  return () => {
    again = true;
    if (running) return running;
    running = (async () => {
      do { again = false; await read(); } while (again);
    })().finally(() => { running = null; });
    return running;
  };
}
