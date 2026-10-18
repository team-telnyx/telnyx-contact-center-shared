import { readOperationConfig, applyOperationConfig, readDefaultModel, AiModelNotConfiguredError } from './catalog.mjs';

// Read settings at request time so web and worker processes observe saves.
// No process-local cache can retain stale instructions after an admin update.
async function readSettings(options) {
  if(options.settings)return options.settings;
  const {getPostgresPool}=await import('../postgres.mjs');
  const pool=options.pool||getPostgresPool();
  return pool?(await pool.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0]?.cc_settings||{}:{};
}

// The platform default model: Admin → AI Copilot (top), then TELNYX_AI_DEFAULT_MODEL.
export async function platformDefaultModel(options={}) {
  return readDefaultModel(await readSettings(options),options.env||process.env);
}

// The model an operation will use and where it comes from:
//   explicit model (workflow, scorecard, channel, one-off test) → preferredSource
//   operation card in Admin → AI Copilot                         → 'ai-copilot'
//   platform default model in Admin → AI Copilot                 → 'default'
//   TELNYX_AI_DEFAULT_MODEL                                      → 'env'
// Throws AiModelNotConfiguredError when none is set; no model is defined in code.
export async function resolveOperationModel(id,{preferredModel=null,preferredSource='workflow',...options}={}) {
  if(preferredModel)return {model:preferredModel,source:preferredSource};
  const settings=await readSettings(options);
  const config=readOperationConfig(settings,id);
  if(config.model)return {model:config.model,source:'ai-copilot'};
  const fallback=readDefaultModel(settings,options.env||process.env);
  if(fallback.model)return {model:fallback.model,source:fallback.source==='env'?'env':'default'};
  throw new AiModelNotConfiguredError();
}

export async function prepareAiOperation(id,body,options={}) {
  const settings=await readSettings(options);
  const defaultModel=readDefaultModel(settings,options.env||process.env).model;
  return applyOperationConfig(id,body,readOperationConfig(settings,id),{preferredModel:options.preferredModel,defaultModel});
}

export async function operationModel(id,preferredModel,options={}) {
  return (await resolveOperationModel(id,{...options,preferredModel})).model;
}
