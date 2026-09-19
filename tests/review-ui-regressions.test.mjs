import test from "node:test";
import assert from "node:assert/strict";
import {createLatestRequestScope} from "../lib/contact-center/latest-request.js";
import {supervisionCustomerIdentity} from "../lib/contact-center/customer-identity.js";
import {isOwnedQueueTransferContinuation} from "../lib/contact-center/queue-transfer-continuation.js";

test("late queue successes and failures cannot replace a newer selection or a closed modal",()=>{
  const scope=createLatestRequestScope(),old=scope.begin(),latest=scope.begin();
  let stats="current queue";
  if(old.isCurrent())stats="stale queue";
  assert.equal(stats,"current queue");assert.equal(old.signal.aborted,true);assert.equal(latest.isCurrent(),true);
  scope.cancel();assert.equal(latest.isCurrent(),false);assert.equal(latest.signal.aborted,true);
  const reopened=scope.begin();assert.equal(reopened.isCurrent(),true);assert.equal(old.isCurrent(),false);
});
test("supervision uses destination identity for outbound and source identity for inbound",()=>{
  const call={fromName:"Campaign",fromNumber:"+12025550100",toName:"Customer",toNumber:"+12025550101"};
  assert.deepEqual(supervisionCustomerIdentity({...call,direction:"outbound"}),{label:"Customer",detail:call.toNumber});
  assert.deepEqual(supervisionCustomerIdentity({...call,direction:"inbound"}),{label:"Campaign",detail:call.fromNumber});
  assert.equal(supervisionCustomerIdentity({direction:"outbound",fromNumber:call.fromNumber}).detail,"Unknown number");
});
test("a queue-transfer tombstone bypass requires a new assignment owned by the current agent",()=>{
  const marker={expiresAt:2000,assignedAt:"old"};
  const fresh={agent_username:"target",state:"ringing",assigned_at:"new"};
  assert.equal(isOwnedQueueTransferContinuation(fresh,"source",marker,1000),false);
  assert.equal(isOwnedQueueTransferContinuation(fresh,"target",marker,1000),true);
  assert.equal(isOwnedQueueTransferContinuation({...fresh,state:"connected"},"target",marker,1000),true);
  assert.equal(isOwnedQueueTransferContinuation({...fresh,state:"connected",assigned_at:"old"},"target",marker,1000),false);
  assert.equal(isOwnedQueueTransferContinuation(fresh,null,marker,1000),false);
  assert.equal(isOwnedQueueTransferContinuation(fresh,"target",marker,2001),false);
  assert.equal(isOwnedQueueTransferContinuation({interactionId:"id"},"target",marker,1000),false);
});
