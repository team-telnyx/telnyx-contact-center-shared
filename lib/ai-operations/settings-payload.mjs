// Shared payload for the Admin → AI Copilot API: operation cards, reply
// suggestion channels and the platform default model, with the model each
// operation will actually use and where it comes from.
import { createHash } from 'node:crypto';
import { AI_OPERATIONS, DEFAULT_MODEL_ENV, readDefaultModel, readOperationConfig } from './catalog.mjs';
import { AI_OPERATION_USAGE } from './usage.mjs';
import { chatCopilotFromAppSettings } from '../contact-center/chat-copilot-settings.mjs';

export const COPILOT_CHANNELS = ['chat','sms','whatsapp','email'];

export function copilots(settings){
  return Object.fromEntries(COPILOT_CHANNELS.map(channel=>[channel,channel==='chat'?chatCopilotFromAppSettings(settings):settings?.[`${channel}_copilot`]||null]));
}

export function operationRevision(settings,id){
  return createHash('sha256').update(JSON.stringify([readOperationConfig(settings,id),id==='reply-suggestions'?copilots(settings):null])).digest('hex');
}

export function defaultModelRevision(settings){
  return createHash('sha256').update(JSON.stringify(['ai_default_model',settings?.ai_default_model??null])).digest('hex');
}

// The model a card uses when nothing more specific is chosen at request time.
function effective(config,platform){
  if(config.model)return {model:config.model,source:'ai-copilot'};
  if(platform.model)return {model:platform.model,source:platform.source==='env'?'env':'default'};
  return {model:'',source:null};
}

export function aiOperationsPayload(settings,canEdit,env=process.env){
  const platform=readDefaultModel(settings,env);
  const channelModels=copilots(settings);
  return {
    ok:true,
    canEdit,
    defaultModel:{
      model:platform.model,
      source:platform.source,
      saved:typeof settings?.ai_default_model==='string'?settings.ai_default_model:'',
      envVariable:DEFAULT_MODEL_ENV,
      envModel:typeof env?.[DEFAULT_MODEL_ENV]==='string'?env[DEFAULT_MODEL_ENV].trim():'',
      revision:defaultModelRevision(settings),
    },
    operations:AI_OPERATIONS.map(item=>{
      const config=readOperationConfig(settings,item.id);
      const base=effective(config,platform);
      // Reply suggestions: the chat channel model is the explicit choice shown on the card.
      const shown=item.id==='reply-suggestions'&&channelModels.chat?.model?{model:channelModels.chat.model,source:'channel'}:base;
      return {...item,usage:AI_OPERATION_USAGE[item.id],config,effective:shown,inherited:base,revision:operationRevision(settings,item.id)};
    }),
    copilots:channelModels,
  };
}
