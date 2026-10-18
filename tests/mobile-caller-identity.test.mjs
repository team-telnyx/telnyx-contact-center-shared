import assert from 'node:assert/strict';
import test from 'node:test';
import { listAgentInteractionViews } from '../lib/acd/work-item-repository.mjs';

function database(rows, contacts = [], fails = false) {
  const calls = [];
  return { calls, async query(sql, args) {
    calls.push({sql, args});
    if (sql.includes('FROM acd_history_interactions h')) return { rows };
    assert.match(sql, /FROM contacts t/);
    if (fails) throw new Error('contact lookup temporarily unavailable');
    return { rows: contacts };
  }};
}

test('active mobile voice cards use batched contact identities for inbound and outbound calls', async () => {
  const db = database([
    {id:'in',interaction_type:'voice',direction:'inbound',from_number:'+48 600 000 001'},
    {id:'out',interaction_type:'voice',direction:'outbound',from_number:'+12025550000',to_number:'+12025550102'},
    {id:'chat',interaction_type:'chat',customer_name:'Website visitor'},
  ], [
    {normalized_phone:'48600000001',record:{id:'one',first_name:'Alex',last_name:'Morgan'}},
    {normalized_phone:'12025550102',record:{id:'two',display_name:'Emma Wilson'}},
  ]);
  const result = await listAgentInteractionViews(db, 'agent-1');
  assert.equal(result[0].customer_name, 'Alex Morgan');
  assert.equal(result[1].from_name, 'Emma Wilson');
  assert.equal(result[2].customer_name, 'Website visitor');
  assert.equal(db.calls.length, 2);
  assert.deepEqual(db.calls[1].args[0], ['48600000001','12025550102']);
  assert.equal(db.calls[0].args[0], 'agent-1');
});

test('unmatched numbers and contact outages preserve the call and existing caller name', async () => {
  const row = {id:'voice',interaction_type:'voice',from_number:'+12025550102',from_name:'Existing caller'};
  for (const fails of [false,true]) {
    const result = await listAgentInteractionViews(database([row], [], fails), 'agent');
    assert.equal(result[0].from_name, 'Existing caller');
    assert.equal(result[0].from_number, row.from_number);
  }
});

test('an empty voice list does not query the contact directory', async () => {
  const db = database([{id:'chat',interaction_type:'chat'}]);
  await listAgentInteractionViews(db, 'agent');
  assert.equal(db.calls.length, 1);
});


test('matched contacts fill missing names without overwriting provider or stored identities', async () => {
  for (const names of [{from_name:'Provider name'}, {customer_name:'Stored customer'},
    {from_name:'Provider name',customer_name:'Stored customer'}]) {
    const row = {id:'voice',interaction_type:'voice',from_number:'+12025550102',...names};
    const db = database([row], [{normalized_phone:'12025550102',record:{display_name:'Directory name'}}]);
    const [result] = await listAgentInteractionViews(db, 'agent');
    assert.equal(result.from_name, names.from_name || names.customer_name);
    assert.equal(result.customer_name, names.customer_name || names.from_name);
  }
});
