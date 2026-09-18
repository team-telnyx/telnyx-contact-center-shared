// A source agent's disposition can overlap the next queue/handling segment.
// Keep those intervals off the customer's sequential phase bar; otherwise a
// wrapup_end event would incorrectly label the next agent's handling as ACW.
export function splitTransferWrapupEvents(events = []) {
  const transferred = event => event.outcome === "transferred"
    && event.segmentId && ["wrapup_start", "wrapup_end"].includes(event.type);
  const ends = new Map(events.filter(event => transferred(event) && event.type === "wrapup_end")
    .map(event => [event.segmentId, event]));
  return {
    events: events.filter(event => !transferred(event)),
    wrapups: events.filter(event => transferred(event) && event.type === "wrapup_start")
      .map(event => {
        const end = ends.get(event.segmentId);
        const seconds = end ? (Date.parse(end.timestamp) - Date.parse(event.timestamp)) / 1000 : null;
        return { ...event, endedAt: end?.timestamp || null,
          durationSeconds: Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : null };
      }),
  };
}
