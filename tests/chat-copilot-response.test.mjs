import {test} from "node:test";
import assert from "node:assert/strict";
import {parseCopilotSuggestions,requestCopilotSuggestions} from "../lib/contact-center/chat-copilot.js";

const input={settings:{model:"zai-org/GLM-5.3",bucketIds:["one","two","three","four","five"]},question:"How can I use Voice API?",messages:[]};
const content=JSON.stringify({suggestions:[{text:"Here is a suggested reply.",confidence:0.8,rationale:"Available documentation."}]});
const completion=(value=content,finish="stop")=>({choices:[{finish_reason:finish,message:{content:value}}],usage:{prompt_tokens:100,completion_tokens:200}});
const pricing={input:1,output:2,unit:"1M_tokens",currency:"USD"};

test("text blocks and explicitly delimited reasoning preserve only validated suggestions",()=>{
  assert.equal(parseCopilotSuggestions([{type:"text",text:content}])[0].confidence,0.8);
  assert.equal(parseCopilotSuggestions(`  <think>Private reasoning</think>\n\n\`\`\`json\n${content}\n\`\`\`  `)[0].text,"Here is a suggested reply.");
  for(const invalid of ["<think>Unfinished reasoning",`Some analysis ${content}`,JSON.stringify({question:input.question}),'{"suggestions":[]}',content.slice(0,-1)]){
    assert.throws(()=>parseCopilotSuggestions(invalid),/usable suggestions/);
  }
});
test("valid response uses one call, supports data envelope and leaves model reasoning enabled",async()=>{
  let calls=0;
  const result=await requestCopilotSuggestions(input,{pricing,request:async(path,{body})=>{
    calls++;assert.equal(path,"/ai/chat/completions");assert.equal(body.model,input.settings.model);
    assert.equal(body.enable_thinking,undefined);assert.equal(body.max_tokens,6000);
    return {data:completion()};
  }});
  assert.equal(calls,1);assert.equal(result.suggestions.length,1);assert.equal(result.usage.estimatedCostUsd,0.0005);
});
test("confirmed malformed JSON retries once without JSON mode, preserving all five buckets and accounting for both calls",async()=>{
  const calls=[];let accessChecks=0;
  const result=await requestCopilotSuggestions(input,{pricing,beforeRetry:async()=>{accessChecks++;},request:async(_path,{body})=>{
    calls.push(body);return calls.length===1?completion(JSON.stringify({question:input.question})):completion();
  }});
  assert.equal(calls.length,2);assert.equal(accessChecks,1);
  assert.deepEqual(calls[0].response_format,{type:"json_object"});assert.equal(calls[1].response_format,undefined);
  for(const body of calls){assert.equal(body.model,input.settings.model);assert.deepEqual(body.tools[0].retrieval.bucket_ids,input.settings.bucketIds);}
  assert.deepEqual(result.usage,{inputTokens:200,outputTokens:400,estimatedCostUsd:0.001});
});
test("truncation preserves the configured token limit on every attempt and never accepts a partial answer",async()=>{
  let calls=0;
  await assert.rejects(requestCopilotSuggestions({...input,settings:{...input.settings,maxTokens:16000}},{request:async(_path,{body})=>{
    calls++;assert.equal(body.max_tokens,16000);return completion(content,"length");
  }}),/token limit/);
  assert.equal(calls,2);
});
test("a second malformed completion stops; unknown usage on either attempt stays unknown",async()=>{
  let calls=0;
  await assert.rejects(requestCopilotSuggestions(input,{request:async()=>{calls++;return completion("No JSON");}}),/usable suggestions/);
  assert.equal(calls,2);calls=0;
  const result=await requestCopilotSuggestions(input,{pricing,request:async()=>++calls===1?{choices:completion("{}").choices}:completion()});
  assert.deepEqual(result.usage,{inputTokens:null,outputTokens:null,estimatedCostUsd:null});
});
test("timeouts, rate limits and provider failures never automatically repeat a request",async()=>{
  for(const status of [429,502,504]){
    let calls=0;
    await assert.rejects(requestCopilotSuggestions(input,{request:async()=>{calls++;throw Object.assign(Error("Provider failure"),{status});}}),e=>e.status===status);
    assert.equal(calls,1);
  }
});
test("revoked access stops the compatibility retry before the second provider call",async()=>{
  let calls=0;
  await assert.rejects(requestCopilotSuggestions(input,{request:async()=>{calls++;return completion("{}");},beforeRetry:async()=>{throw Object.assign(Error("Access revoked"),{status:403});}}),e=>e.status===403);
  assert.equal(calls,1);
});
