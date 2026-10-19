import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoute } from './helpers/route-harness.mjs';
import { defaultScheduleConfig, normalizeNodeConfig } from '../lib/schedules/evaluator.mjs';

const node = { id: 'schedule', type: 'customNode', data: { nodeType: 'schedules', config: defaultScheduleConfig() } };
const a = { id: 'open', data: { nodeType: 'flow_end' } }, b = { id: 'closed', data: { nodeType: 'flow_end' } };
const flow = { nodes: [node, a, b], edges: [{ source: node.id, target: a.id, sourceHandle: 'output-0' }, { source: node.id, target: b.id, sourceHandle: 'output-1' }] };
for (const [status, matched, branch] of [['ok',true,'true'], ['ok',false,'false'], ['error',null,'false'], ['error',null,'true']]) {
  test(`Schedules engine routes ${status}/${branch} and exposes the structured decision`, async () => {
    const events = [], event = { data: { id: 'event' } }, state = { flowId: 'flow', variables: {} };
    const decision = { status, matched, branch, resultVariable: 'hours' };
    const engine = await loadRoute('lib/voice-flow-engine.js', {
      '@/config/voice-flow-nodes.js': { getNodeById: () => ({ id: 'schedules' }) },
      '@/lib/variable-utils.js': { replaceTemplateVariables: v => v },
      '@/lib/schedules/runtime.mjs': { runScheduleNode: async (n, call, ev, s) => { assert.equal(n,node); assert.equal(ev,event); assert.equal(s,state); return decision; } },
      '@/lib/call-monitor-store.js': { addNodeActivation() {}, addNodeExecutionEvent: (...args) => events.push(args) },
      './voice/logging.mjs': { voiceRuntimePayload: v => v, voiceFlowLogger: { debug() {}, info() {}, warn() {}, error() {} } },
    });
    const result = await engine.executeFlowNode(node,'call',event,state);
    assert.equal(result.success,true); assert.equal(result.output,branch === 'true' ? 0 : 1); assert.deepEqual(result.variables.hours,decision);
    assert.equal(events[0][5],status === 'ok'); state.lastOutput=result.output;
    assert.equal(engine.determineNextNode(flow,node,event,state).id,branch === 'true' ? 'open' : 'closed');
    assert.deepEqual(engine.determineNextNodes(flow,node,event,state).map(n=>n.id),[branch === 'true' ? 'open' : 'closed']);
    const missing = {...flow,edges:flow.edges.filter(e=>e.target!==(branch === 'true' ? 'open':'closed'))};
    assert.equal(engine.determineNextNode(missing,node,event,state),null);
    assert.deepEqual(engine.determineNextNodes(missing,node,event,state),[]);
  });
}
test('Flow validation requires both schedule branches and a valid calendar selection', async () => {
  const validator = await loadRoute('lib/voice-flow-validator.js', {
    '@/config/voice-flow-nodes.js': { getNodeById: id => ({id,config:{}}) },
    './schedules/evaluator.mjs': {normalizeNodeConfig},
    '@/lib/variable-utils.js': {getAllVariableNames:()=>[],validateVariableReferences:()=>({valid:true,errors:[],warnings:[]}),validateVariableName:()=>({valid:true})},
    '@/lib/expression-engine.js': { validateExpression:()=>({valid:true}) },
  });
  const start = {id:'start',data:{nodeType:'incoming_call',config:{}}};
  const full = {...flow,nodes:[start,...flow.nodes],edges:[{source:'start',target:node.id,sourceHandle:'output-0'},...flow.edges]};
  assert.equal(validator.validateFlow(full).valid,true);
  assert.match(validator.validateFlow({...full,edges:full.edges.filter(e=>e.target!=='closed')}).errors.join('\n'),/False output/);
  const bad = structuredClone(full);bad.nodes[1].data.config.useExceptions=true;
  assert.match(validator.validateFlow(bad).errors.join('\n'),/Select a calendar/);
});
