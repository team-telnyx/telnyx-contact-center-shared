import test from 'node:test';
import assert from 'node:assert/strict';
import {hydrateWorkflowCanvasNodes, addAssistantHandoff, updateAssistantHandoff, toReactFlowNodes, toReactFlowEdges, reactFlowToConversationFlow} from '../lib/ai/assistant-workflow-canvas.mjs';
import {validateConversationFlow, validateWorkflowNode} from '../lib/ai/assistant-conversation-workflow.mjs';
import {assistantCreateWirePayload, assistantUpdateWirePayload} from '../lib/ai/assistant-payload.mjs';

const base = () => ({start_node_id:'welcome',nodes:[{id:'welcome',type:'prompt',name:'Welcome',instructions:'Welcome the caller.',position:{x:100,y:100}}],edges:[]});
const roundTrip = flow => reactFlowToConversationFlow({flow,nodes:toReactFlowNodes(flow),edges:toReactFlowEdges(flow)});
const connect = (flow, id=flow._assistantDrafts.at(-1).id, source='welcome') => updateAssistantHandoff(flow,id,{start_node_id:source,target:{assistant_id:'assistant-test'},condition:{type:'llm',prompt:'The caller asks for help.'}});
const connectedPair = () => connect(addAssistantHandoff(connect(addAssistantHandoff(base()))));

test('adding assistant cards never creates connections, even with a selected source', () => {
 let flow=addAssistantHandoff(base(),{sourceNodeId:'welcome',position:{x:12,y:42}});
 const id=toReactFlowNodes(flow)[1].id;
 flow=addAssistantHandoff(flow,{sourceNodeId:id});
 assert.equal(flow.edges.length,0);assert.equal(flow.nodes.length,1);
 assert.equal(toReactFlowNodes(flow).length,3);
 assert.equal(new Set(flow._assistantDrafts.map(n=>n.id)).size,2);
 assert.deepEqual(toReactFlowNodes(flow)[1].position,{x:12,y:42});
 const rehydrated=toReactFlowNodes(roundTrip(flow));
 assert.equal(rehydrated[1].id,id);
 assert.equal(validateConversationFlow(flow).filter(e=>e.includes('not connected')).length,2);
 assert(validateWorkflowNode(rehydrated[1].data.node,flow).some(e=>e.includes('not connected')));
});

test('disconnected assistants can be configured and moved before connecting explicitly', () => {
 let flow=addAssistantHandoff(base());const id=flow._assistantDrafts[0].id;
 flow=updateAssistantHandoff(flow,id,{target:{assistant_id:'assistant-test',voice_mode:'distinct'}});
 const nodes=toReactFlowNodes(flow);nodes[1].position={x:500,y:700};
 flow=reactFlowToConversationFlow({flow,nodes,edges:[]});
 assert.equal(flow.edges.length,0);assert.equal(flow._assistantDrafts[0].target.assistant_id,'assistant-test');
 flow=connect(flow,id);
 assert.equal(flow._assistantDrafts,undefined);
 assert.equal(toReactFlowNodes(flow)[1].id,nodes[1].id);
 assert.deepEqual(flow.edges[0].target.position,{x:500,y:700});
 assert.equal(flow.edges[0].target.voice_mode,'distinct');
 assert.deepEqual(validateConversationFlow(flow),[]);
 assert.deepEqual(roundTrip(flow),flow);
});

test('repeated handoffs to the same destination stay independent', () => {
 const flow=connectedPair();const nodes=toReactFlowNodes(flow);
 assert.equal(nodes.length,3);assert.notEqual(nodes[1].id,nodes[2].id);
 assert.notDeepEqual(nodes[1].position,nodes[2].position);
 assert.deepEqual(roundTrip(flow),flow);
});

test('deleting a connection preserves the assistant card, configuration and position for reconnecting', () => {
 const flow=connectedPair();const nodes=toReactFlowNodes(flow),edges=toReactFlowEdges(flow);
 const disconnected=reactFlowToConversationFlow({flow,nodes,edges:edges.slice(1)});
 assert.equal(toReactFlowNodes(disconnected).length,3);
 assert.equal(disconnected.edges.length,1);
 assert.deepEqual(disconnected._assistantDrafts[0].target,flow.edges[0].target);
 assert.deepEqual(disconnected._assistantDrafts[0].condition,flow.edges[0].condition);
 assert.deepEqual(toReactFlowNodes(roundTrip(disconnected)),toReactFlowNodes(disconnected));
 const reconnect=updateAssistantHandoff(disconnected,flow.edges[0].id,{start_node_id:'welcome'});
 assert.equal(reconnect._assistantDrafts,undefined);assert.equal(reconnect.edges.length,2);
 assert.deepEqual(validateConversationFlow(reconnect),[]);
});

test('deleting a card removes its connection; deleting its source keeps the disconnected card visible', () => {
 const flow=connectedPair();const nodes=toReactFlowNodes(flow),edges=toReactFlowEdges(flow);
 const removed=reactFlowToConversationFlow({flow,nodes:nodes.filter(n=>n.id!==nodes[1].id),edges});
 assert.equal(removed.edges.length,1);assert.equal(toReactFlowNodes(removed).length,2);
 const withoutSource=reactFlowToConversationFlow({flow,nodes:nodes.slice(1),edges});
 assert.equal(withoutSource.edges.length,0);assert.equal(withoutSource._assistantDrafts.length,2);
 assert.equal(withoutSource.start_node_id,'');
});

test('legacy invisible placeholders are recovered separately and errors have no technical IDs', () => {
 const flow=connectedPair();
 flow.edges.forEach((e,i)=>{e.id=`e_welcome_assistant:pending_1792068986200_${i}`;e.target.assistant_id='';e.condition.prompt='';});
 flow.edges[1].target.position={...flow.edges[0].target.position};
 const snapshot=structuredClone(flow),nodes=toReactFlowNodes(flow);
 assert.equal(nodes.length,3);assert.notDeepEqual(nodes[1].position,nodes[2].position);assert.deepEqual(flow,snapshot);
 const messages=validateConversationFlow(flow);
 assert.equal(messages.length,4);assert(messages.every(e=>e.includes('Welcome')&&!e.includes('pending_')));
});

test('connection defaults apply only after explicitly connecting speak/tool steps', () => {
 for(const type of ['speak','tool']) {
  const b=base();b.nodes[0].type=type;
  let flow=addAssistantHandoff(b);assert.equal(flow.edges.length,0);
  flow=updateAssistantHandoff(flow,flow._assistantDrafts[0].id,{start_node_id:'welcome'});
  assert.deepEqual(flow.edges[0].condition,{type:'default'});
  flow=addAssistantHandoff(flow);flow=updateAssistantHandoff(flow,flow._assistantDrafts[0].id,{start_node_id:'welcome'});
  assert.deepEqual(flow.edges[1].condition,{type:'llm',prompt:''});
 }
});

test('hydration keeps measurements and exposes newly added disconnected nodes', () => {
 const flow=addAssistantHandoff(base()),measured=toReactFlowNodes(flow).map(n=>({...n,width:280,height:80}));
 const next=hydrateWorkflowCanvasNodes(measured,addAssistantHandoff(flow));
 assert.equal(next[0].width,280);assert.equal(next[1].height,80);assert.equal(next[2].width,undefined);
});

test('reachability rejects isolated nodes and disconnected cycles, while allowing start and reachable loops', () => {
 const flow=base();assert.deepEqual(validateConversationFlow(flow),[]);
 flow.nodes.push({...flow.nodes[0],id:'second',name:'Second'}, {...flow.nodes[0],id:'third',name:'Third'});
 flow.edges=[{id:'a',start_node_id:'second',target:{type:'node',node_id:'third'},condition:{type:'llm',prompt:'continue'}},{id:'b',start_node_id:'third',target:{type:'node',node_id:'second'},condition:{type:'llm',prompt:'repeat'}}];
 assert.equal(validateConversationFlow(flow).filter(e=>e.includes('not connected')).length,2);
 assert(validateWorkflowNode(flow.nodes[1],flow).some(e=>e.includes('not connected')));
 flow.edges.push({id:'c',start_node_id:'welcome',target:{type:'node',node_id:'second'},condition:{type:'llm',prompt:'continue'}});
 assert.deepEqual(validateConversationFlow(flow),[]);assert.deepEqual(validateWorkflowNode(flow.nodes[1],flow),[]);
});

test('Telnyx wire payload never contains editor-only drafts or silently drops disconnected cards', () => {
 for(const serialize of [assistantCreateWirePayload,assistantUpdateWirePayload]) {
  assert.throws(()=>serialize({conversation_flow:addAssistantHandoff(base())}),/Connect every assistant step/);
  const flow=connect(addAssistantHandoff(base()));
  const result=serialize({conversation_flow:{...flow,_assistantDrafts:[]}});
  assert.deepEqual(result.conversation_flow,flow);
 }
});
