const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
export function qualityRating(mos) {
  if (mos == null) return "Waiting for media";
  return mos > 4.2
    ? "Excellent"
    : mos >= 4.1
      ? "Good"
      : mos >= 3.7
        ? "Fair"
        : mos >= 3.1
          ? "Poor"
          : "Bad";
}
export function estimatedMOS(jitter, rtt, loss) {
  if ([jitter, rtt, loss].some((x) => finite(x) === null)) return null;
  const latency = jitter + rtt / 2;
  const delay =
    0.024 * latency + (latency > 177.3 ? 0.11 * (latency - 177.3) : 0);
  const r = Math.max(0, Math.min(100, 93.2 - delay - 2.5 * loss));
  return Math.max(
    1,
    Math.min(5, 1 + 0.035 * r + 0.000007 * r * (r - 60) * (100 - r)),
  );
}
export function createQualityAccumulator() {
  let previous = new Map();
  return (report, now = Date.now()) => {
    const rows = [...report.values()];
    const audio = (type) =>
      rows.filter(
        (s) => s.type === type && (s.kind || s.mediaType) === "audio",
      );
    const inbound = audio("inbound-rtp"),
      outbound = audio("outbound-rtp");
    let received = 0,
      lost = 0,
      rx = 0,
      tx = 0,
      hasLoss = false,
      hasRX = false,
      hasTX = false;
    const next = new Map();
    for (const row of [...inbound, ...outbound]) {
      const key = `${row.type}:${row.id}:${row.ssrc}`;
      const old = previous.get(key),
        timestamp = finite(row.timestamp) ?? now;
      next.set(key, { ...row, timestamp });
      const elapsed = old ? (timestamp - old.timestamp) / 1000 : 0;
      if (!old || elapsed <= 0 || elapsed > 15) continue;
      const delta = (field) =>
        finite(row[field]) !== null &&
        finite(old[field]) !== null &&
        row[field] >= old[field]
          ? row[field] - old[field]
          : null;
      if (row.type === "inbound-rtp") {
        const a = delta("packetsReceived"),
          b = delta("packetsLost"),
          bytes = delta("bytesReceived");
        if (a !== null && b !== null) {
          received += a;
          lost += b;
          hasLoss = true;
        }
        if (bytes !== null) {
          rx += (bytes * 8) / elapsed / 1000;
          hasRX = true;
        }
      } else {
        const bytes = delta("bytesSent");
        if (bytes !== null) {
          tx += (bytes * 8) / elapsed / 1000;
          hasTX = true;
        }
      }
    }
    previous = next;
    const lossPercent =
      hasLoss && received + lost > 0 ? (100 * lost) / (received + lost) : null;
    const jitter = inbound
      .map((s) => finite(s.jitter))
      .filter((x) => x !== null);
    const transport = rows.find(
      (s) => s.type === "transport" && s.selectedCandidatePairId,
    );
    const pair =
      rows.find((s) => s.id === transport?.selectedCandidatePairId) ||
      rows.find(
        (s) =>
          s.type === "candidate-pair" && s.state === "succeeded" && s.nominated,
      );
    const remote = audio("remote-inbound-rtp")
      .map((s) => finite(s.roundTripTime))
      .filter((x) => x !== null);
    const rtt = remote.length
      ? Math.max(...remote)
      : finite(pair?.currentRoundTripTime);
    const jitterMS = jitter.length ? Math.max(...jitter) * 1000 : null,
      rttMS = rtt === null ? null : rtt * 1000;
    const level = (type) => {
      const values = audio(type)
        .map((s) => finite(s.audioLevel))
        .filter((x) => x !== null);
      return values.length ? Math.min(1, Math.max(...values)) : null;
    };
    return {
      timestamp: now,
      mos: estimatedMOS(jitterMS, rttMS, lossPercent),
      jitterMS,
      rttMS,
      lossPercent,
      receiveKbps: hasRX ? rx : null,
      sendKbps: hasTX ? tx : null,
      receiveLevel: level("inbound-rtp"),
      sendLevel: level("media-source"),
    };
  };
}
