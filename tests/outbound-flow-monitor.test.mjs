import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const routeSourcePromise = readFile(new URL('../app/api/voice/webhook/incoming/[flowId]/route.js', import.meta.url), 'utf8');

test('outbound campaign webhook logs initiator monitor event with flow variables', async () => {
  const source = await routeSourcePromise;

  assert.match(source, /addNodeExecutionEvent/);
  assert.match(source, /recordOutboundCampaignInitiatorMonitorEvent/);
  assert.match(source, /node_execution:outbound_campaign|outbound_campaign/);
  assert.match(source, /variables/);
  assert.match(source, /call_control_id/);
  assert.match(source, /contact_record/);
  assert.match(source, /outbound_campaign_id/);
});
