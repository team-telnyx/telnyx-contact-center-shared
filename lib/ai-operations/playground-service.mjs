import { buildOperationPreview, validateOperationOutput } from './playground.mjs';

export async function readPlaygroundInput(request) {
 const text=await request.text();
 if(text.length>60000)throw Object.assign(new Error('Keep the complete test input within 60,000 characters.'),{status:400});
 try{return JSON.parse(text);}catch{throw Object.assign(new Error('Test input must be valid JSON.'),{status:400});}
}
export function safePreview(input,options={}){
 try{return buildOperationPreview(input,options);}catch(error){throw Object.assign(new Error(error?.issues?'Check the operation, model, instructions and sample JSON.':error.message||'Invalid sample context.'),{status:error?.status===503?503:400});}
}
export async function runOperationTest(input,{fetchImpl=fetch,apiKey=process.env.TELNYX_API_KEY,signal,defaultModel}={}){
 const preview=safePreview(input,{defaultModel});
 if(!apiKey)throw Object.assign(new Error('Telnyx AI is not configured.'),{status:503});
 const started=Date.now();
 let response;
 try{
  const timeout=AbortSignal.timeout(60000);
  response=await fetchImpl('https://api.telnyx.com/v2/ai/chat/completions',{
   method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
   body:JSON.stringify(preview.request),cache:'no-store',signal:signal?AbortSignal.any([signal,timeout]):timeout,
  });
 }catch{throw Object.assign(new Error('The test was cancelled or the model did not respond within 60 seconds.'),{status:504});}
 const data=await response.json().catch(()=>null);
 if(!response.ok){
  // Provider bodies can echo submitted content; never return them to logs/UI.
  const status=response.status;
  throw Object.assign(new Error(status===429?'Telnyx rate limit reached. Try again shortly.':`Telnyx rejected the test (HTTP ${status}). Check model access and supported request parameters in the preview.`),{status:status===429?429:502,providerStatus:status});
 }
 const payload=data?.data||data,choice=payload?.choices?.[0],content=choice?.message?.content;
 const output=Array.isArray(content)?content.map(part=>typeof part==='string'?part:part?.text||'').join(''):typeof content==='string'?content:'';
 return {ok:true,model:preview.request.model,elapsedMs:Date.now()-started,finishReason:choice?.finish_reason||null,
  usage:{inputTokens:payload?.usage?.prompt_tokens??null,outputTokens:payload?.usage?.completion_tokens??null},
  output,validation:validateOperationOutput(input.id,output,input.sample,choice?.finish_reason),
  request:preview.request,note:preview.note};
}
