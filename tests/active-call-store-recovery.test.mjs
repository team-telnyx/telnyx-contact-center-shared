import test from 'node:test';
import assert from 'node:assert/strict';
import store from '../lib/stores/active-call-store.js';

test('SDK reattachment preserves the conversation, audio-control state and original CC identity',()=>{
  const previous={id:'device-1',state:'recovering',options:{customHeaders:[{name:'X-CC-Work-Id',value:'work-1'}]}};
  const contactCenter={interactionId:'interaction-1',queueName:'Test'};
  const ui={isRinging:false,isHeld:false,isMuted:true,duration:47};
  const transcriptions=[{transcript:'Existing conversation'}];
  store.setState({call:previous,recoveredCallHeaders:[],contactCenter,ui,transcriptions,
    status:'active',originalCallControlId:'customer-1',answeredAt:1000});
  const recovered={id:'device-2',recoveredCallId:'device-1',state:'answering'};
  assert.equal(store.getState().adoptRecoveredCall(recovered),true);
  const result=store.getState();
  assert.equal(result.call,recovered);
  assert.equal(result.contactCenter,contactCenter);
  assert.equal(result.ui,ui);
  assert.equal(result.transcriptions,transcriptions);
  assert.equal(result.originalCallControlId,'customer-1');
  assert.equal(result.answeredAt,1000);
  assert.equal(result.status,'active');
  assert.deepEqual(result.recoveredCallHeaders,previous.options.customHeaders);
  assert.equal(result.adoptRecoveredCall(recovered),false);
  const again={id:'device-3',recoveredCallId:'device-2',state:'active'};
  assert.equal(store.getState().adoptRecoveredCall(again),true);
  assert.deepEqual(store.getState().recoveredCallHeaders,previous.options.customHeaders);
});

test('unrelated, unproven, terminal and stale recovery cannot replace the active call',()=>{
  const current={id:'current',state:'active'};
  store.setState({call:current,recoveredCallHeaders:[]});
  for(const candidate of [null,{id:'current',state:'active'},
    {id:'other',recoveredCallId:'foreign',state:'active'},
    {id:'old',recoveredCallId:'current',state:'destroy'}]){
    assert.equal(store.getState().adoptRecoveredCall(candidate),false);
    assert.equal(store.getState().call,current);
  }
  store.setState({call:null});
  assert.equal(store.getState().adoptRecoveredCall({id:'late',recoveredCallId:'current',state:'active'}),false);
});
