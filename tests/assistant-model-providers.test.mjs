import test from 'node:test';
import { usesManualAssistantModelEntry } from '../lib/ai/model-providers.mjs';
import assert from 'node:assert/strict';
import {modelProvider,providerOptions,normalizeFastRouterCatalog,switchExternalAuthentication,integrationSecretOptions,assistantCatalogModels} from '../lib/ai/model-providers.mjs';
test('token credential options exclude basic secrets and identify their type',()=>{
 const secrets=[{identifier:'token',type:'bearer'},{identifier:'password',type:'basic'},{identifier:'unknown',type:''}];
 assert.deepEqual(integrationSecretOptions(secrets),[{value:'token',label:'token (bearer)'}]);
 assert.equal(integrationSecretOptions(secrets,null).length,3);
});
test('hosting provider comes from owned_by, not model author prefix',()=>{
 const models=[{id:'deepseek/deepseek-v3',raw:{owned_by:'Telnyx'}},{id:'llama',raw:{owned_by:'groq'}}];
 assert.equal(modelProvider({model:models[0].id},models),'telnyx');assert.equal(providerOptions(models).length,7);
 assert.equal(modelProvider({model:'retired-model'},models),'unlisted');
});
test('FastRouter catalog excludes non-text outputs without interpreting unknown tools as unsupported',()=>{
 const models=normalizeFastRouterCatalog({data:[{id:'chat',architecture:{input_modalities:['text'],output_modalities:['text']}},{id:'image',architecture:{input_modalities:['text'],output_modalities:['image']}},{id:'inactive',is_active:false},{id:'embed',type:'embedding'},{id:'unknown'}]});
 assert.deepEqual(models.map(m=>m.id),['chat','unknown']);assert.equal(models[0].capabilities.tools,null);
});
test('authentication changes explicitly clear credentials from the inactive method',()=>{
 const token={model:'custom',base_url:'https://example.test/v1',authentication_method:'token',llm_api_key_ref:'old-token'};
 const certificate=switchExternalAuthentication(token,'certificate');
 assert.equal(certificate.llm_api_key_ref,'');
 const switched=switchExternalAuthentication({...certificate,certificate_ref:'old-cert',token_retrieval_url:'https://example.test/token'},'token');
 assert.equal(switched.certificate_ref,'');assert.equal(switched.token_retrieval_url,'');assert.equal(switched.llm_api_key_ref,'');
 assert.equal(token.llm_api_key_ref,'old-token');assert.equal(switched.model,token.model);
});

test('assistant model catalog requires an explicit true flag',()=>{
 const catalog=[{id:'allowed',recommended_for_assistants:true},{id:'denied',recommended_for_assistants:false},{id:'missing'},{id:'string',recommended_for_assistants:'true'}];
 assert.deepEqual(assistantCatalogModels(catalog).map(model=>model.id),['allowed']);
 assert.equal(catalog.length,4);
 assert.deepEqual(assistantCatalogModels(null),[]);
});
test('FastRouter fixed IDs remain configurable without weakening assistant catalog filtering',()=>{
 const eligible=assistantCatalogModels(normalizeFastRouterCatalog({data:[{id:'provider/model'}]}));
 assert.deepEqual(eligible,[]);
 assert.equal(usesManualAssistantModelEntry('fastrouter','fixed',eligible.length),true);
 assert.equal(usesManualAssistantModelEntry('fastrouter','fixed',1),false);
 assert.equal(usesManualAssistantModelEntry('fastrouter','virtual',1),true);
 assert.equal(usesManualAssistantModelEntry('telnyx','fixed',0),false);
 assert.equal(usesManualAssistantModelEntry('custom','fixed',0),true);
});
