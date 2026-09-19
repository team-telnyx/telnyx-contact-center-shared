// Child-process boundary used only against the isolated test database.
import pg from 'pg';
import { generatorTick } from '../../lib/call-generator/runtime.mjs';
const config=JSON.parse(process.env.GENERATOR_TEST_DB);
if(config.database!=='acd_generator_live_runtime_test')throw new Error('Refusing non-test database');
const pool=new pg.Pool({...config,max:3});
globalThis.fetch=async()=>{throw new Error('No network in generator worker fixture');};
try {
 await generatorTick(pool,{node:`fixture-${process.pid}`,originate:async()=>{
  process.send?.({dial:true});
  if(process.env.GENERATOR_TEST_CRASH==='true')process.exit(23);
  await new Promise(resolve=>setTimeout(resolve,100));return {ok:false,reason:'unknown'};
 }});
}finally{await pool.end();process.disconnect?.();}
