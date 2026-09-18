import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAcdTimeline, createAcdHistoryDto } from '../lib/acd/history-projection.mjs';
import { splitTransferWrapupEvents } from '../lib/acd/transfer-wrapup-timeline.mjs';

for (const channel of ['chat', 'email', 'voice', 'sms', 'whatsapp']) {
  test(`${channel}: overlapping transfer wrap-ups retain segment timing without consuming destination handling`, () => {
    const input = {
      workItem: { id: 'work', channel, state: 'completed', created_at: '2026-09-14T00:00:00Z', terminal_at: '2026-09-14T00:05:15Z' },
      agentUsernames: { a: 'Alice', b: 'Bob' },
      segments: [
        { id: 'a1', kind: 'agent', seq: 1, agent_id: 'a', outcome: 'transferred', started_at: '2026-09-14T00:00:00Z', ended_at: '2026-09-14T00:01:00Z', wrapup_ended_at: '2026-09-14T00:03:00Z' },
        { id: 'b1', kind: 'agent', seq: 2, agent_id: 'b', outcome: 'transferred', started_at: '2026-09-14T00:01:00Z', ended_at: '2026-09-14T00:02:00Z', wrapup_ended_at: '2026-09-14T00:04:00Z' },
        { id: 'c1', kind: 'agent', seq: 3, agent_id: 'c', outcome: 'completed', started_at: '2026-09-14T00:02:00Z', ended_at: '2026-09-14T00:05:00Z', wrapup_ended_at: '2026-09-14T00:05:15Z' },
      ],
    };
    const { events, wrapups } = splitTransferWrapupEvents(buildAcdTimeline(input).timeline);
    assert.deepEqual(wrapups.map(w => [w.segmentId, w.agentUsername, w.durationSeconds]), [['a1', 'Alice', 120], ['b1', 'Bob', 120]]);
    assert.equal(events.filter(e => e.type === 'wrapup_start').length, 1, 'only final wrap-up belongs to the sequential path');
    assert.equal(events.filter(e => e.type === 'wrapup_end').length, 1);
    assert.equal(createAcdHistoryDto(input).metrics.wrapupSeconds, 255);
    const handling = events.findIndex(e => e.type === 'connected' && e.agentId === 'c');
    assert.equal(events[handling + 1].type, 'disconnected');
    assert.equal(Date.parse(events[handling + 1].timestamp) - Date.parse(events[handling].timestamp), 180000);
  });
}

test('pending and genuinely instantaneous transferred wrap-ups remain distinguishable', () => {
  const start = { type: 'wrapup_start', segmentId: 's1', outcome: 'transferred', timestamp: '2026-09-14T00:01:00Z' };
  assert.equal(splitTransferWrapupEvents([start]).wrapups[0].durationSeconds, null);
  assert.equal(splitTransferWrapupEvents([start, { ...start, type: 'wrapup_end' }]).wrapups[0].durationSeconds, 0);
});
