import test from "node:test";
import assert from "node:assert/strict";
import {
  createQualityAccumulator,
  estimatedMOS,
  qualityRating,
} from "../lib/telephony/quality.mjs";
const report = (
  n,
  { ssrc = 1, lost = 0, received = n * 50, rx = n * 1000, tx = n * 500 } = {},
) =>
  new Map([
    [
      "in",
      {
        id: "in",
        ssrc,
        type: "inbound-rtp",
        kind: "audio",
        timestamp: n * 1000,
        packetsReceived: received,
        packetsLost: lost,
        bytesReceived: rx,
        jitter: 0.01,
      },
    ],
    [
      "out",
      {
        id: "out",
        ssrc,
        type: "outbound-rtp",
        kind: "audio",
        timestamp: n * 1000,
        bytesSent: tx,
      },
    ],
    [
      "pair",
      {
        id: "pair",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        currentRoundTripTime: 0.1,
      },
    ],
  ]);
test("first sample and absent media do not fabricate zero loss or MOS", () => {
  const sample = createQualityAccumulator();
  const first = sample(report(1), 1000);
  assert.equal(first.lossPercent, null);
  assert.equal(first.mos, null);
  assert.equal(first.receiveKbps, null);
  assert.equal(sample(new Map(), 2000).jitterMS, null);
});
test("current packet loss, seconds-to-ms and bitrate use intervals", () => {
  const sample = createQualityAccumulator();
  sample(report(1));
  const second = sample(report(2, { lost: 2 }));
  assert.equal(second.lossPercent, (100 * 2) / 52);
  assert.equal(second.jitterMS, 10);
  assert.equal(second.rttMS, 100);
  assert.equal(second.receiveKbps, 8);
  assert.equal(second.sendKbps, 4);
  assert.ok(second.mos >= 1 && second.mos <= 5);
});
test("SSRC changes, negative counters and stale sampling reset baselines", () => {
  const sample = createQualityAccumulator();
  sample(report(1));
  assert.equal(sample(report(2, { ssrc: 2 })).lossPercent, null);
  assert.equal(
    sample(report(3, { received: 1, lost: -1, rx: 1, tx: 1 })).lossPercent,
    null,
  );
  assert.equal(sample(report(30)).receiveKbps, null);
});
test("MOS remains unavailable without timing and grades degradation", () => {
  assert.equal(estimatedMOS(null, 100, 0), null);
  assert.equal(estimatedMOS(0, Infinity, 0), null);
  assert.ok(estimatedMOS(5, 50, 0) > estimatedMOS(50, 400, 5));
  assert.equal(qualityRating(null), "Waiting for media");
  assert.equal(qualityRating(4.15), "Good");
});
