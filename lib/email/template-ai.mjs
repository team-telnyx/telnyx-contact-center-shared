import { emailTemplateSystem } from '../ai-operations/prompts/core.mjs';
import { prepareAiOperation, operationModel } from '../ai-operations/runtime.mjs';
import { z } from 'zod';
import { widgetAiRequest } from '../widgets/ai-provider.js';
import { emailError } from './provider.mjs';
import { emailHtmlText } from './content.mjs';

const inputSchema=z.object({
  prompt:z.string().trim().min(1).max(4000),model:z.string().trim().min(1).max(200),
  format:z.enum(['html','plain']).default('html'),
  template:z.object({name:z.string().max(120),subject:z.string().max(998),html_body:z.string().max(30000),text_body:z.string().max(30000)}).optional(),
}).strict();
const text=value=>typeof value==='string'?value.trim():'';
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\n','<br>');

export async function emailTemplateModels(request=widgetAiRequest,{pool}={}){
  const payload=await request('/ai/models');
  return {defaultModel:await operationModel("email-template",undefined,{pool}).catch(()=>null),models:(payload.data||[]).filter(m=>m.id&&(!m.task||/text[ -]generation|chat/i.test(m.task))).map(m=>({id:m.id,name:m.name||m.id,raw:m}))};
}

export function parseEmailTemplateResult(content,format){
  const cleaned=text(content).replace(/<think>[\s\S]*?<\/think>/gi,'').replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  let parsed;
  try{parsed=JSON.parse(cleaned.slice(cleaned.indexOf('{'),cleaned.lastIndexOf('}')+1));}catch{throw emailError('Telnyx AI returned an invalid template. Try again.',502);}
  if(!parsed||Array.isArray(parsed)||['name','subject','html_body','text_body'].some(k=>parsed[k]!=null&&typeof parsed[k]!=='string'))throw emailError('Telnyx AI returned an invalid template. Try again.',502);
  const name=text(parsed.name)||'email-template',subject=text(parsed.subject);
  const textBody=text(parsed.text_body)||emailHtmlText(parsed.html_body),htmlBody=format==='plain'?'':text(parsed.html_body)||escape(textBody);
  if(!subject||!textBody||name.length>120||subject.length>998||/[\r\n]/.test(subject)||textBody.length>30000||htmlBody.length>30000)throw emailError('Telnyx AI returned an incomplete or oversized template. Try again.',502);
  return {name,subject,html_body:htmlBody,text_body:textBody};
}

export async function generateEmailTemplate(input,{request=widgetAiRequest,pool}={}){
  const validated=inputSchema.safeParse(input);
  if(!validated.success)throw emailError('Select a model and format, and describe the template in 1–4000 characters. Keep the current template within the supported size limits.');
  const {prompt,model,format,template}=validated.data;
  const body=await prepareAiOperation("email-template",{model,stream:false,temperature:0.55,max_tokens:2400,enable_thinking:false,messages:[
    {role:'system',content:emailTemplateSystem(format)},
    {role:'user',content:JSON.stringify({requirements:prompt,current_template:template||null})},
  ]},{preferredModel:model,pool});
  for(let attempt=0;attempt<2;attempt++){
    const payload=await request('/ai/chat/completions',{method:'POST',body:{...body,...(attempt===0?{response_format:{type:'json_object'}}:{})}});
    const choice=payload.choices?.[0]||payload.data?.choices?.[0];
    const raw=choice?.message?.content;
    const content=Array.isArray(raw)?raw.map(part=>typeof part==='string'?part:typeof part?.text==='string'?part.text:'').join('\n'):raw;
    try{
      if(choice?.finish_reason==='length')throw emailError('The generated template was truncated. Request a shorter template.',502);
      return {ok:true,model,format,result:parseEmailTemplateResult(content,format)};
    }catch(error){if(attempt===1)throw error;}
  }
}
