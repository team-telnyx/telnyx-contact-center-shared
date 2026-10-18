import { z } from 'zod';
import { operationDefinition, applyOperationConfig, operationConfigSchema } from './catalog.mjs';
import { AI_OPERATION_USAGE } from './usage.mjs';
import * as core from './prompts/core.mjs';
import { buildSystemPrompt as qualitySystem, buildUserPrompt as qualityUser } from './prompts/quality.mjs';
import { buildPromptsForScenarioType } from './prompts/scenario.mjs';
import { buildSuggestionSystemPrompt, buildSuggestionUserPrompt } from './prompts/suggestion.mjs';
import { buildCustomerReplyPrompt, buildPreviewSamplePrompt } from './prompts/caller.mjs';
import { buildResponsePrompt } from './prompts/web-caller.mjs';
import { buildWorkflowAnalysisSystemPrompt, buildWorkflowAnalysisUserPrompt } from '../agent-assist/workflow-prompts.js';
import { buildFormAiSystemPrompt, buildFormAiUserPayload, FORM_AI_OPERATION_SCHEMA } from '../forms/form-ai-instructions.js';
import { buildCopilotRequest } from '../contact-center/chat-copilot.js';
import { DEFAULT_CHAT_COPILOT_SETTINGS, parseChatCopilotSettings } from '../contact-center/chat-copilot-settings.mjs';

const transcript='Customer: I need to move my appointment. Agent: I changed it to Thursday at 2 pm. Customer: Thank you, that resolves my request.';
const item={item_id:'preferred_day',id:'preferred_day',type:'slot',label:'Preferred day',stage_name:'Appointment',slot_name:'day',slot_type:'text',completion_trigger:'customer',prompt_hint:'What day would you prefer?'};
const workflow={name:'Synthetic appointment intake',description:'Collect a preferred day.',items:[item],stages:[{name:'Appointment',items:[item]}]};
const scorecard={sections:[{id:'service',title:'Service',criteria:[{id:'resolution',label:'Resolution',type:'score',maxScore:5,weight:1,aiRubric:'5: resolved and confirmed; 0: unresolved.'}]}]};
const samples={
 'reply-suggestions':{question:'Can you confirm the appointment time?',messages:[{sender_role:'customer',body:'Please move my appointment.'},{sender_role:'agent',body:'Your appointment is now Thursday at 2 pm.'}],channel:'chat',subject:'Appointment'},
 'kb-response':{transcript:'How can I reset my password?',articleContent:'Use Forgot password on the sign-in screen. The reset link expires after 30 minutes.'},
 'workflow-analysis':{transcript:'Thursday would be best.',speaker:'customer',pendingItems:[item],slotsFilled:{},confidenceThreshold:0.95,currentTarget:null,currentStageName:'Appointment',isReadBackStage:false,allowCorrections:false,correctionInProgress:false},
 'workflow-suggestion':{itemType:'slot',itemLabel:'Preferred day',itemDescription:'Ask for an appointment day.',agentName:'Alex',brandName:'Example Support',targetMode:'collect_slot',previousConversation:[],prefilledSlots:{}},
 'sentiment-intent':{transcript:'This is the third time I have called. I am frustrated that my appointment is still missing.',includeIntent:true,includeSentiment:true},
 'live-translation':{text:'Your appointment is Thursday at 2 pm.',sourceLanguage:'en',targetLanguage:'pl'},
 'quality-evaluation':{transcriptText:transcript,schema:scorecard,aiPromptConfig:{},context:{agentName:'Alex Example',queueName:'Support',channel:'chat',direction:'inbound'}},
 'call-summary':{transcriptionText:transcript},
 'email-template':{prompt:'Write a concise appointment confirmation using {{ first_name }} and {{ appointment_time }}.',format:'html',template:null},
 'form-builder':{prompt:'Add a required email field with variableName customer_email.',currentForm:{name:'Synthetic intake',schema:{pages:[{id:'details',title:'Details',fields:[]}]}}},
 'assistant-summary':{assistant:{name:'Appointment helper',description:'Answers appointment questions.',model:'Example model',voice:'Example voice',instructions:'Help customers understand appointment details.',enabled_features:['voice','chat'],tools:[]}},
 'preview-translation':{text:'Welcome to our support team.',sourceLanguage:'en',targetLanguage:'pl'},
 'test-scenario':{scenarioType:'workflow_specific',workflow},
 'test-caller':{variant:'web',workflow,transcript:'What day would you prefer?',history:[],persona:'cooperative',slotCount:1,expressiveKind:null,customerData:{name:'Alex Example',preferred_day:'Thursday'},isFirstResponse:false},
 'voice-sample':{persona:'cooperative',voice:'AWS.Polly.Joanna',expressive:false},
};
export function operationSample(id){operationDefinition(id);return structuredClone(samples[id]);}
export const playgroundSchema=z.object({id:z.string().max(80),config:operationConfigSchema,model:z.string().trim().max(200).optional(),sample:z.record(z.string(),z.unknown()),copilot:z.unknown().optional()}).strict();
const fail=message=>Object.assign(new Error(message),{status:400});
const messages=(system,user)=>[{role:'system',content:system},{role:'user',content:user}];
function required(sample,key){if(typeof sample[key]!=='string'||!sample[key].trim())throw fail(`Sample requires a non-empty ${key}.`);return sample[key];}
function jsonObject(sample,key){if(!sample[key]||typeof sample[key]!=='object'||Array.isArray(sample[key]))throw fail(`Sample requires ${key} as an object.`);return sample[key];}

// Only shared prompt builders are invoked. No interaction mutation, form edit,
// evaluation save, message delivery, TTS or call initiation occurs in this runner.
// defaultModel: the platform default model (Admin → AI Copilot top or
// TELNYX_AI_DEFAULT_MODEL), supplied by the server.
export function buildOperationPreview(input,{defaultModel}={}){
 const {id,config,model,sample:s,copilot}=playgroundSchema.parse(input);
 operationDefinition(id);
 if(JSON.stringify(s).length>40000)throw fail('Keep sample data within 40,000 characters.');
 let body={temperature:0.3,max_tokens:1000,stream:false},note='';
 switch(id){
  case 'reply-suggestions':
   if(!Array.isArray(s.messages))throw fail('Sample messages must be an array.');
   body=buildCopilotRequest({settings:copilot?parseChatCopilotSettings(copilot):DEFAULT_CHAT_COPILOT_SETTINGS,question:required(s,'question'),messages:s.messages,channel:s.channel||'chat',subject:s.subject||'',handoff:s.handoff});
   break;
  case 'kb-response':body={...body,temperature:0.7,enable_thinking:false,messages:messages(core.kbSystem(),core.kbUser(required(s,'transcript'),s.articleContent||''))};note='Production streams the reply. This test collects one completed response, capped at 1,000 output tokens.';break;
  case 'workflow-analysis':
   if(!Array.isArray(s.pendingItems)||!s.pendingItems.length)throw fail('Provide at least one pending workflow item.');
   body={...body,max_tokens:Math.min(1200,Math.max(512,300+s.pendingItems.length*50+s.pendingItems.filter(i=>i.type==='slot').length*50)),temperature:0.3,enable_thinking:s.reasoningEnabled===true,response_format:{type:'json_object'},messages:messages(buildWorkflowAnalysisSystemPrompt({...s,slotsFilled:s.slotsFilled||{}}),buildWorkflowAnalysisUserPrompt({...s,transcript:required(s,'transcript')}))};
   note='The sample represents context after workflow targeting and MCP-owned fields have been filtered. No workflow state is modified; fallback models are not retried.';break;
  case 'workflow-suggestion':body={...body,max_tokens:90,temperature:0.4,enable_thinking:s.reasoningEnabled===true,messages:messages(buildSuggestionSystemPrompt(s),buildSuggestionUserPrompt({...s,itemLabel:required(s,'itemLabel')}))};note='Exercises the AI branch. Templates and deterministic suggestions normally bypass the model.';break;
  case 'sentiment-intent':
   if(s.includeIntent===false&&s.includeSentiment===false)throw fail('Enable intent or sentiment for this test.');
   body={...body,max_tokens:s.includeIntent!==false&&s.includeSentiment!==false?180:100,enable_thinking:false,response_format:{type:'json_object'},messages:messages(core.sentimentSystem(s),`Analyze this transcription segment:\n\n"${required(s,'transcript')}"`)};note='Live auxiliary analysis has a 5-second timeout. The tester waits up to 60 seconds and reports latency instead of silently falling back to neutral.';break;
  case 'live-translation':body={...body,temperature:0,enable_thinking:false,max_tokens:Math.min(1200,Math.max(120,Math.ceil(required(s,'text').length*1.5))),response_format:{type:'json_object'},messages:messages(core.liveTranslationSystem(),JSON.stringify({source_language:s.sourceLanguage||'auto',target_language:required(s,'targetLanguage'),transcript:s.text.trim()}))};break;
  case 'quality-evaluation':
   jsonObject(s,'schema');if(!s.schema.sections?.some(section=>section.criteria?.length))throw fail('Provide a scorecard with criteria.');
   body={...body,max_tokens:4000,temperature:0.2,messages:messages(qualitySystem(s.aiPromptConfig),qualityUser({...s,transcriptText:required(s,'transcriptText')}))};note='Criteria and persona come from this synthetic scorecard. Tests never create or finalize an evaluation.';break;
  case 'call-summary':body={...body,temperature:0.7,max_tokens:300,messages:messages(core.callSummarySystem(),core.callSummaryUser(required(s,'transcriptionText')))};break;
  case 'email-template':if(!['html','plain'].includes(s.format))throw fail('Format must be html or plain.');body={...body,temperature:0.55,max_tokens:2400,enable_thinking:false,response_format:{type:'json_object'},messages:messages(core.emailTemplateSystem(s.format),JSON.stringify({requirements:required(s,'prompt'),current_template:s.template||null}))};break;
  case 'form-builder':body={...body,temperature:0.1,max_tokens:4000,response_format:{type:'json_object'},guided_json:FORM_AI_OPERATION_SCHEMA,messages:messages(buildFormAiSystemPrompt(),buildFormAiUserPayload({prompt:required(s,'prompt'),currentForm:jsonObject(s,'currentForm')}))};note='Returned operations are displayed only. No form is modified; provider compatibility retries are not applied.';break;
  case 'assistant-summary':{
   const a=jsonObject(s,'assistant'),compact=(v,f='Not configured')=>String(v||f).trim();
   body={...body,temperature:0.35,max_tokens:180,messages:messages(core.assistantSummarySystem(),`Assistant ID: draft\nName: ${compact(a.name,'Unnamed assistant')}\nDescription: ${compact(a.description,'')}\nModel: ${compact(a.model)}\nFallback model: ${a.fallback_enabled?compact(a.fallback_model):'Disabled'}\nSTT model/provider: ${compact(a.transcription?.model)}\nTTS voice: ${compact(a.voice)}\nTools: ${a.tools?.length||0}\nIntegrations: ${a.integrations?.length||0}\nMCP servers: ${a.mcp_servers?.length||0}\nDynamic variables: ${Object.keys(a.dynamic_variables||{}).length}\nEnabled features: ${a.enabled_features?.join(', ')||'None'}\nInstructions: ${String(a.instructions||'').slice(0,2400)}`)};break;
  }
  case 'preview-translation':body={...body,temperature:0,max_tokens:500,messages:messages(core.previewTranslationSystem(),`Source language: ${s.sourceLanguage||'auto'}\nTarget language: ${required(s,'targetLanguage')}\nText:\n${required(s,'text')}`)};break;
  case 'test-scenario':{
   if(!['workflow_specific','early_transfer','mid_workflow_transfer','out_of_order','frustrated_customer'].includes(s.scenarioType))throw fail('Choose a supported scenarioType.');
   const prompt=buildPromptsForScenarioType(s.scenarioType,jsonObject(s,'workflow')),user=prompt.buildUserPrompt(s.workflow);if(!user)throw fail('This scenario requires collectible workflow items.');
   body={...body,temperature:0.9,max_tokens:2000,response_format:{type:'json_object'},enable_thinking:s.reasoningEnabled===true,messages:messages(prompt.system,user)};break;
  }
  case 'test-caller':{
   if(!['web','generated-call'].includes(s.variant))throw fail('Caller variant must be web or generated-call.');
   jsonObject(s,'workflow');required(s,'transcript');
   const context={...s,slotCount:Math.max(1,Math.min(5,Number(s.slotCount)||1))};
   body={...body,temperature:0.7,max_tokens:160,messages:s.variant==='generated-call'?buildCustomerReplyPrompt(context):buildResponsePrompt({...context,conversationHistory:s.history||[],lastAiMessage:s.transcript,workflowItems:s.workflow.items||[],pendingItems:s.workflow.items||[]})};break;
  }
  case 'voice-sample':body={...body,temperature:0.8,max_tokens:80,messages:buildPreviewSamplePrompt(s)};break;
 }
 const baseline=body;
 // Channel models are authoritative in production; an explicit test model can
 // override them for a one-off comparison without saving any settings.
 const channelModel=id==='reply-suggestions'&&copilot&&typeof copilot.model==='string'?copilot.model:undefined;
 body=applyOperationConfig(id,body,config,{preferredModel:model||channelModel||undefined,defaultModel});
 return {id,usage:AI_OPERATION_USAGE[id],baseline,request:body,note,scope:'One Chat Completions request. No business actions or settings are saved.'};
}

// Structural checks, not a claim that the model is factually correct. Render raw
// output alongside checks so administrators can judge content and latency.
export function validateOperationOutput(id,raw,sample,finishReason){
 const issues=[];let parsed=null;
 const structured=['reply-suggestions','workflow-analysis','sentiment-intent','live-translation','quality-evaluation','email-template','form-builder','test-scenario'].includes(id);
 if(finishReason==='length')issues.push('Output reached the token limit and may be incomplete.');
 if(typeof raw!=='string'||!raw.trim())issues.push('The model returned no text.');
 if(structured){try{parsed=JSON.parse(raw);}catch{issues.push('Output is not strict JSON.');}}
 if(structured&&parsed!==null&&(typeof parsed!=='object'||Array.isArray(parsed))){issues.push('Expected a JSON object.');parsed=null;}
 if(structured&&parsed===null&&!issues.length)issues.push('Expected a JSON object.');
 if(parsed){
  const list=(key)=>Array.isArray(parsed[key]);
  if(id==='reply-suggestions'&&(!list('suggestions')||parsed.suggestions.length<1||parsed.suggestions.length>5||parsed.suggestions.some(x=>typeof x.text!=='string'||!x.text.trim()||typeof x.confidence!=='number'||x.confidence<0||x.confidence>1)))issues.push('Expected 1–5 suggestions with text and confidence 0–1.');
  if(id==='workflow-analysis'&&(!list('completed_items')||parsed.completed_items.some(x=>!sample.pendingItems.some(i=>i.item_id===x.item_id))))issues.push('Expected completed_items with IDs from the sample workflow.');
  if(id==='sentiment-intent'){
   if(sample.includeIntent!==false&&(typeof parsed.intent!=='string'||!Array.isArray(parsed.tags)||parsed.tags.length>3))issues.push('Expected intent and up to three tags.');
   if(sample.includeSentiment!==false&&(!['positive','neutral','negative'].includes(parsed.sentiment)||typeof parsed.sentimentScore!=='number'||parsed.sentimentScore<0||parsed.sentimentScore>100))issues.push('Expected sentiment and sentimentScore 0–100.');
  }
  if(id==='live-translation'&&(typeof parsed.translated_text!=='string'||!('detected_source_language' in parsed)))issues.push('Expected translated_text and detected_source_language.');
  if(id==='quality-evaluation'){
   const criteria=sample.schema.sections.flatMap(s=>s.criteria||[]);
   if(!list('answers')||criteria.some(c=>{const matches=parsed.answers.filter(a=>a.criterionId===c.id);return matches.length!==1||(!matches[0].na&&(!Number.isFinite(matches[0].score)||matches[0].score<0||matches[0].score>c.maxScore));}))issues.push('Expected one answer per criterion with scores inside scorecard bounds.');
  }
  if(id==='email-template'&&['name','subject','html_body','text_body'].some(k=>typeof parsed[k]!=='string'))issues.push('Expected name, subject, html_body and text_body strings.');
  if(id==='form-builder'&&(!list('operations')||parsed.operations.some(op=>!FORM_AI_OPERATION_SCHEMA.properties.operations.items.properties.type.enum.includes(op.type))))issues.push('Expected supported form operations.');
  if(id==='test-scenario'&&(!list('responses')||!parsed.responses.length||parsed.responses.some(r=>typeof r.text!=='string'||!Array.isArray(r.keywords))||parsed.responses[0].waitForGreeting!==true))issues.push('Expected customer responses, keywords and initial waitForGreeting.');
 }
 return {valid:issues.length===0,issues,parsed,label:'Structural checks only; review accuracy and usefulness manually.'};
}
