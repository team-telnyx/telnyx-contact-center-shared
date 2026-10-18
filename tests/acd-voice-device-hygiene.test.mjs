import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareAcdTestPool,seedAgent} from './helpers/acd-test-db.mjs';
import {registerVoiceEndpoint,chooseVoiceEndpoint,authenticateVoiceEndpoint,readVoiceEndpoints,listVoiceDevices,forgetVoiceEndpoint,forgetVoiceDevice,sweepStaleVoiceEndpoints,followComputerSelection,revokeAuthVoiceEndpoints} from '../lib/acd/voice-endpoints.mjs';
import {heartbeatAgentSession} from '../lib/acd/sessions.mjs';
const pool=await prepareAcdTestPool('cc_voice_device_hygiene_test');
after(async()=>{await pool.end();});

async function agent() {
  const agentId=randomUUID();await seedAgent(pool,agentId);
  const login=()=>({id:agentId,authSessionId:randomUUID()});
  const register=async(user,body,viaPool=pool)=>(await registerVoiceEndpoint(viaPool,user,{deviceId:randomUUID(),...body},async id=>({id:`cred-${id}`,username:id}))).registration;
  const online=async(user,registration)=>{const e=await authenticateVoiceEndpoint(pool,user,registration.token);await heartbeatAgentSession(pool,{agentId,sessionId:registration.id,voiceEndpoint:e,voiceReady:true,ready:{video:false}});};
  const age=(id,hours)=>pool.query(`UPDATE cc_voice_endpoints SET expires_at=now()-make_interval(hours=>$2),socket_ready_until=now()-make_interval(hours=>$2),created_at=created_at-make_interval(hours=>$2),last_seen_at=now()-make_interval(hours=>$2) WHERE id=$1`,[id,hours]);
  return {agentId,login,register,online,age};
}

test('old logins of one phone and registrations not seen for a day leave the picker; the selected one stays, labelled unavailable',async()=>{
 const a=await agent();
 const phone=randomUUID();
 const oldLogin=a.login(),newLogin=a.login(),web=a.login(),dead=a.login();
 const old=await a.register(oldLogin,{kind:'ios',deviceId:phone,label:'iPhone'});
 await a.age(old.id,2);
 const current=await a.register(newLogin,{kind:'ios',deviceId:phone,label:'iPhone'});await a.online(newLogin,current);
 const computer=await a.register(web,{kind:'web'});await a.online(web,computer);
 const forgotten=await a.register(dead,{kind:'android',label:'Old Android'});await a.age(forgotten.id,48);
 const listed=(await readVoiceEndpoints(pool,a.agentId)).endpoints.map(e=>e.id).sort();
 assert.deepEqual(listed,[computer.id,current.id].sort(),'the superseded login and the stale Android are not offered');
 await chooseVoiceEndpoint(pool,{id:a.agentId},{endpointId:computer.id,expectedGeneration:'0'});
 await a.age(computer.id,48);
 const afterwards=await readVoiceEndpoints(pool,a.agentId);
 const selected=afterwards.endpoints.find(e=>e.id===computer.id);
 assert.ok(selected,'the selected device stays listed however stale');assert.equal(selected.reachable,false);
 const devices=(await listVoiceDevices(pool,a.agentId)).devices;
 assert.deepEqual(devices.map(d=>d.kind),['web','ios','android'],'the computer first, then one entry per handset');
 assert.equal(devices.find(d=>d.deviceId===phone).id,current.id,'two logins of one phone are one entry, named by the reachable one');
 assert.equal(devices.find(d=>d.deviceId===phone).stale,false);
 assert.equal(devices.find(d=>d.kind==='android').stale,true);
 assert.equal(devices.find(d=>d.kind==='android').label,'Old Android');
 assert.equal(devices[0].selected,true);assert.equal(devices[0].reachable,false);assert.equal(devices[0].removable,false);
});

test('forgetting a device revokes it, frees its credential and its push registration, and clears the selection when it was the selected one',async()=>{
 const a=await agent();
 const login=a.login();
 const phone=await a.register(login,{kind:'ios',label:'iPhone',formFactor:'phone'});await a.online(login,phone);
 const endpoint=await authenticateVoiceEndpoint(pool,login,phone.token);
 await pool.query(`INSERT INTO cc_mobile_devices(device_id,user_id,kind,auth_session_id,voip_token,name,system_version,app_version,bundle_identifier,environment)
   VALUES($1,$2,'ios',$3,'ab12','iPhone','26','0.3.1','com.novumcx.telnyx','prod')`,[endpoint.device_id,a.agentId,login.authSessionId]);
 await chooseVoiceEndpoint(pool,{id:a.agentId},{endpointId:phone.id,expectedGeneration:'0'});
 const released=[];
 const other={id:randomUUID()};await seedAgent(pool,other.id);
 await assert.rejects(forgetVoiceEndpoint(pool,other,phone.id,{release:async id=>released.push(id)}),{status:404},'only the owner forgets a device');
 const result=await forgetVoiceEndpoint(pool,{id:a.agentId},phone.id,{release:async id=>released.push(id)});
 assert.deepEqual(released,[endpoint.credential_id]);
 assert.deepEqual(result.devices.map(d=>d.id),['computer'],'only the computer is left');assert.equal(result.endpointId,null);
 assert.equal((await pool.query('SELECT revoked_at FROM cc_voice_endpoints WHERE id=$1',[phone.id])).rows[0].revoked_at!==null,true);
 assert.equal((await pool.query('SELECT 1 FROM cc_mobile_devices WHERE device_id=$1',[endpoint.device_id])).rowCount,0);
 assert.equal((await pool.query('SELECT credential_id FROM cc_voice_endpoints WHERE id=$1',[phone.id])).rows[0].credential_id,null,'the row gives up the released credential');
 const user=(await pool.query('SELECT telephony_credentials_id,telephony_user_name FROM users WHERE id=$1',[a.agentId])).rows[0];
 assert.deepEqual(user,{telephony_credentials_id:null,telephony_user_name:null},'the released credential leaves the user row');
 await assert.rejects(authenticateVoiceEndpoint(pool,login,phone.token),{status:403},'the forgotten registration no longer authenticates');
 assert.equal((await readVoiceEndpoints(pool,a.agentId)).generation,'2','the selection generation moved on');
});

test('the sweep revokes registrations stale for a month and frees their credentials, leaving live and selected ones alone',async()=>{
 const a=await agent();
 const stale=a.login(),live=a.login(),chosen=a.login();
 const gone=await a.register(stale,{kind:'android',label:'Gone'});await a.age(gone.id,24*40);
 const fresh=await a.register(live,{kind:'ios'});await a.online(live,fresh);
 const selected=await a.register(chosen,{kind:'web'});await a.online(chosen,selected);
 await chooseVoiceEndpoint(pool,{id:a.agentId},{endpointId:selected.id,expectedGeneration:'0'});await a.age(selected.id,24*40);
 const released=[];
 const swept=await sweepStaleVoiceEndpoints(pool,{release:async id=>released.push(id)});
 assert.ok(swept.includes(gone.id));assert.ok(!swept.includes(fresh.id));assert.ok(!swept.includes(selected.id),'the selected device is never swept');
 assert.ok(released.includes(`cred-${gone.id}`));
 assert.equal((await listVoiceDevices(pool,a.agentId)).devices.map(d=>d.id).includes(gone.id),false);
});

test('a forgotten device registers again with a fresh credential, never the one it released',async()=>{
 const a=await agent();
 const login=a.login(),phone=randomUUID();
 const first=await a.register(login,{kind:'ios',deviceId:phone,label:'iPhone'});await a.online(login,first);
 const before=(await pool.query('SELECT credential_id FROM cc_voice_endpoints WHERE id=$1',[first.id])).rows[0].credential_id;
 const released=[];
 await forgetVoiceEndpoint(pool,{id:a.agentId},first.id,{release:async id=>released.push(id)});
 assert.deepEqual(released,[before]);
 // The same installation, the same login: the registration row comes back, with a credential of its own.
 const again=await a.register(login,{kind:'ios',deviceId:phone,label:'iPhone'});
 const rows=(await pool.query('SELECT id,credential_id,sip_username,revoked_at FROM cc_voice_endpoints WHERE agent_id=$1 AND device_id=$2',[a.agentId,phone])).rows;
 assert.equal(rows.length,1,'the registration row is reactivated, not duplicated');
 assert.equal(rows[0].id,again.id);assert.equal(rows[0].revoked_at,null);
 assert.ok(rows[0].credential_id&&rows[0].credential_id!==before,'a fresh credential replaces the released one');
 assert.equal(rows[0].sip_username,rows[0].credential_id.replace('cred-',''));
 const endpoint=await authenticateVoiceEndpoint(pool,login,again.token);
 assert.equal(endpoint.credential_id,rows[0].credential_id);
});

test('a connected browser is not hidden behind a newer tab that was opened and closed; last seen is the heartbeat, never a lease deadline',async()=>{
 const a=await agent();
 const first=a.login(),second=a.login();
 const connected=await a.register(first,{kind:'web'});await a.online(first,connected);
 await pool.query(`UPDATE cc_voice_endpoints SET created_at=created_at-interval '1 hour' WHERE id=$1`,[connected.id]);
 await a.register(second,{kind:'web'}); // registered, never heartbeated: unreachable
 const listed=(await readVoiceEndpoints(pool,a.agentId)).endpoints.map(e=>e.id);
 assert.ok(listed.includes(connected.id),'the connected browser stays offered');
 const devices=(await listVoiceDevices(pool,a.agentId)).devices;
 assert.equal(devices.length,1,'two tabs are the one computer');
 assert.equal(devices[0].reachable,true);assert.equal(devices[0].availability,'connected');
 const seen=new Date(devices[0].lastSeenAt).getTime();
 assert.ok(seen<=Date.now()+1000 && seen>Date.now()-60000,'last seen is now, not the lease deadline');
});

test('the sweep re-checks under the lock: a candidate selected or heartbeated meanwhile is kept',async()=>{
 const a=await agent();
 const login=a.login();
 const phone=await a.register(login,{kind:'ios'});await a.age(phone.id,24*40);
 // Selected after the candidate query would have picked it: the lock re-check must keep it.
 const realPool={query:(...args)=>pool.query(...args),connect:async()=>{
   await pool.query('UPDATE cc_agent_voice_preferences SET endpoint_id=$2 WHERE agent_id=$1',[a.agentId,phone.id]);
   return pool.connect();
 }};
 const released=[];
 const swept=await sweepStaleVoiceEndpoints(realPool,{release:async id=>released.push(id)});
 assert.ok(!swept.includes(phone.id));assert.deepEqual(released,[]);
 assert.equal((await pool.query('SELECT revoked_at FROM cc_voice_endpoints WHERE id=$1',[phone.id])).rows[0].revoked_at,null);
});

test('re-registering keeps a credential renewed meanwhile, and starts over when the one it read was released meanwhile',async()=>{
 const a=await agent();
 const login=a.login(),phone=randomUUID();
 const first=await a.register(login,{kind:'ios',deviceId:phone});
 // The registration reads the row, then opens its transaction (its third connection): what lands in between is the race.
 const racing=(change)=>{let connects=0;return {query:(...args)=>pool.query(...args),connect:async()=>{if(++connects===3)await change();return pool.connect();}};};
 await a.register(login,{kind:'ios',deviceId:phone},racing(()=>pool.query('UPDATE cc_voice_endpoints SET credential_id=$2,sip_username=$3 WHERE id=$1',[first.id,'cred-renewed','renewed'])));
 const row=(await pool.query('SELECT credential_id,sip_username FROM cc_voice_endpoints WHERE id=$1',[first.id])).rows[0];
 assert.deepEqual(row,{credential_id:'cred-renewed',sip_username:'renewed'},'the renewal is not overwritten by the credential read before it');
 await assert.rejects(a.register(login,{kind:'ios',deviceId:phone},racing(()=>pool.query('UPDATE cc_voice_endpoints SET credential_id=NULL,sip_username=NULL,revoked_at=now() WHERE id=$1',[first.id]))),
   {status:409},'a credential released meanwhile is never written back');
 const again=await a.register(login,{kind:'ios',deviceId:phone});
 assert.ok((await authenticateVoiceEndpoint(pool,login,again.token)).credential_id,'the next registration provisions afresh');
});

const logins=(...ids)=>JSON.stringify(ids.map(sessionId=>({sessionId,refreshToken:`hash-${sessionId}`,expiresAt:new Date(Date.now()+86400000).toISOString()})));
const loginIds=async agentId=>(await pool.query('SELECT refresh_tokens FROM users WHERE id=$1',[agentId])).rows[0].refresh_tokens.map(login=>login.sessionId).sort();

test('the computer is exactly one entry, listed with no registration at all and with many browsers and tabs, and is never forgotten',async()=>{
 const a=await agent();
 const empty=(await listVoiceDevices(pool,a.agentId)).devices;
 assert.deepEqual(empty.map(d=>[d.id,d.kind,d.label,d.removable,d.selected,d.reachable,d.lastSeenAt]),[['computer','web','Computer',false,false,false,null]]);
 const first=a.login(),second=a.login();
 const tabs=[await a.register(first,{kind:'web',label:'Computer'}),await a.register(first,{kind:'web',label:'Computer'}),await a.register(second,{kind:'web',label:'Computer'})];
 await a.online(first,tabs[1]);
 const devices=(await listVoiceDevices(pool,a.agentId)).devices;
 assert.equal(devices.length,1,'three tabs over two sign-ins are one computer');
 assert.equal(devices[0].availability,'connected');
 for (const tab of tabs) await assert.rejects(forgetVoiceEndpoint(pool,{id:a.agentId,authSessionId:first.authSessionId},tab.id),{status:409});
 const webDevice=(await pool.query('SELECT device_id FROM cc_voice_endpoints WHERE id=$1',[tabs[0].id])).rows[0].device_id;
 await assert.rejects(forgetVoiceDevice(pool,{id:a.agentId},webDevice),{status:409},'nor by its device id');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM cc_voice_endpoints WHERE agent_id=$1 AND revoked_at IS NULL',[a.agentId])).rows[0].n,3,'nothing was revoked');
});

test('forgetting a phone takes the whole installation: every login of it, its credentials, its push registration and its sign-ins, and nothing else',async()=>{
 const a=await agent();
 const phoneId=randomUUID(),oldLogin=a.login(),newLogin=a.login(),web=a.login(),tabletLogin=a.login();
 const old=await a.register(oldLogin,{kind:'ios',deviceId:phoneId,label:'iPhone'});await a.age(old.id,2);
 const current=await a.register(newLogin,{kind:'ios',deviceId:phoneId,label:'iPhone'});await a.online(newLogin,current);
 const tablet=await a.register(tabletLogin,{kind:'ios',label:'iPad',formFactor:'tablet'});await a.online(tabletLogin,tablet);
 const computer=await a.register(web,{kind:'web'});await a.online(web,computer);
 await pool.query(`INSERT INTO cc_mobile_devices(device_id,user_id,kind,auth_session_id,voip_token,alert_token,name,bundle_identifier,environment)
   VALUES($1,$2,'ios',$3,'ab12','cd34','iPhone','com.novumcx.telnyx','prod')`,[phoneId,a.agentId,newLogin.authSessionId]);
 await pool.query('UPDATE users SET refresh_tokens=$2::jsonb WHERE id=$1',[a.agentId,logins(oldLogin.authSessionId,newLogin.authSessionId,web.authSessionId,tabletLogin.authSessionId)]);
 const listed=(await listVoiceDevices(pool,a.agentId)).devices;
 assert.equal(listed.filter(d=>d.deviceId===phoneId).length,1,'the two logins of the phone are one entry');
 const released=[];
 const result=await forgetVoiceDevice(pool,{id:a.agentId,authSessionId:web.authSessionId},phoneId,{release:async id=>released.push(id)});
 assert.deepEqual(released.sort(),[`cred-${old.id}`,`cred-${current.id}`].sort(),'both credentials, and so their VoIP push bindings, are freed');
 assert.deepEqual((await pool.query('SELECT id FROM cc_voice_endpoints WHERE agent_id=$1 AND device_id=$2 AND revoked_at IS NULL',[a.agentId,phoneId])).rows,[]);
 assert.equal((await pool.query('SELECT 1 FROM cc_mobile_devices WHERE device_id=$1',[phoneId])).rowCount,0,'no more notifications');
 assert.deepEqual(await loginIds(a.agentId),[web.authSessionId,tabletLogin.authSessionId].sort(),'the phone is signed out; the computer and the iPad are not');
 assert.deepEqual(result.devices.map(d=>d.kind),['web','ios']);
 assert.equal(result.devices[1].id,tablet.id);assert.equal(result.devices[1].formFactor,'tablet');
 await assert.rejects(authenticateVoiceEndpoint(pool,newLogin,current.token),{status:403,code:'VOICE_ENDPOINT_REVOKED'});
 await assert.rejects(forgetVoiceDevice(pool,{id:a.agentId},phoneId),{status:404},'forgetting twice finds nothing');
});

test('a handset registered only for notifications is listed and forgettable; forgetting never signs out the login asking',async()=>{
 const a=await agent();
 const handset=randomUUID(),login=a.login();
 await pool.query(`INSERT INTO cc_mobile_devices(device_id,user_id,kind,auth_session_id,fcm_token,name,bundle_identifier,environment)
   VALUES($1,$2,'android',$3,'fcm-token','Pixel','com.novumcx.telnyx','prod')`,[handset,a.agentId,login.authSessionId]);
 await pool.query('UPDATE users SET refresh_tokens=$2::jsonb WHERE id=$1',[a.agentId,logins(login.authSessionId)]);
 const listed=(await listVoiceDevices(pool,a.agentId)).devices;
 assert.deepEqual(listed.map(d=>[d.kind,d.label,d.pushOnly||false,d.removable]),[['web','Computer',false,false],['android','Pixel',true,true]]);
 const result=await forgetVoiceDevice(pool,{id:a.agentId,authSessionId:login.authSessionId},handset);
 assert.deepEqual(result.devices.map(d=>d.id),['computer']);
 assert.equal((await pool.query('SELECT 1 FROM cc_mobile_devices WHERE device_id=$1',[handset])).rowCount,0);
 assert.deepEqual(await loginIds(a.agentId),[login.authSessionId],'the request\'s own login stays');
});

test('a browser tab unused for a day is swept with its credential unless it takes the calls; a phone keeps its month',async()=>{
 const a=await agent();
 const web=a.login(),chosen=a.login(),phone=a.login();
 const closedTab=await a.register(web,{kind:'web'});await a.age(closedTab.id,25);
 const recentTab=await a.register(web,{kind:'web'});await a.age(recentTab.id,2);
 const selected=await a.register(chosen,{kind:'web'});await a.online(chosen,selected);
 await chooseVoiceEndpoint(pool,{id:a.agentId},{endpointId:selected.id,expectedGeneration:'0'});await a.age(selected.id,25);
 const handset=await a.register(phone,{kind:'ios'});await a.age(handset.id,25);
 const released=[];
 const swept=await sweepStaleVoiceEndpoints(pool,{release:async id=>released.push(id)});
 assert.ok(swept.includes(closedTab.id));assert.ok(released.includes(`cred-${closedTab.id}`));
 for (const kept of [recentTab,selected,handset]) assert.ok(!swept.includes(kept.id));
 assert.equal((await listVoiceDevices(pool,a.agentId)).devices[0].selected,true,'the computer still takes the calls');
});

test('the computer\'s calls follow a connected tab when the tab holding them is gone, and only then',async()=>{
 const a=await agent();
 const web=a.login(),other=a.login(),phoneLogin=a.login();
 const tabA=await a.register(web,{kind:'web'});await a.online(web,tabA);
 const tabB=await a.register(other,{kind:'web'});await a.online(other,tabB);
 assert.equal(await followComputerSelection(pool,a.agentId),null,'nothing chosen yet: nothing is chosen for the agent');
 await chooseVoiceEndpoint(pool,{id:a.agentId},{endpointId:tabA.id,expectedGeneration:'0'});
 assert.equal(await followComputerSelection(pool,a.agentId),null,'the tab holding the calls is connected: they stay');
 const endpointA=await authenticateVoiceEndpoint(pool,web,tabA.token);
 await heartbeatAgentSession(pool,{agentId:a.agentId,sessionId:tabA.id,voiceEndpoint:endpointA,offline:true});
 await pool.query(`UPDATE acd_agent_state SET workflow_state='wrapup',workflow_deadline_at=now()+interval '1 minute' WHERE agent_id=$1`,[a.agentId]);
 assert.equal(await followComputerSelection(pool,a.agentId),null,'voice work in progress keeps its tab');
 await pool.query(`UPDATE acd_agent_state SET workflow_state='idle',workflow_deadline_at=NULL WHERE agent_id=$1`,[a.agentId]);
 assert.equal(await followComputerSelection(pool,a.agentId),tabB.id,'closed: the calls move to the connected tab');
 const state=await readVoiceEndpoints(pool,a.agentId);
 assert.equal(state.endpointId,tabB.id);assert.equal(state.generation,'2');
 const identity=(await pool.query('SELECT telephony_credentials_id,telephony_user_name FROM users WHERE id=$1',[a.agentId])).rows[0];
 assert.deepEqual(identity,{telephony_credentials_id:`cred-${tabB.id}`,telephony_user_name:tabB.id},'routing rings the connected tab');
 const session=(await pool.query('SELECT capabilities FROM acd_agent_sessions WHERE id=$1',[tabB.id])).rows[0];
 assert.equal(session.capabilities.voice,true);
 const event=(await pool.query(`SELECT payload FROM acd_events WHERE agent_id=$1 AND type='voice_endpoint_changed' ORDER BY id DESC LIMIT 1`,[a.agentId])).rows[0];
 assert.equal(event.payload.reason,'computer_tab_changed');
 // A phone chosen explicitly is never left for a browser tab.
 const phone=await a.register(phoneLogin,{kind:'ios'});await a.online(phoneLogin,phone);
 await chooseVoiceEndpoint(pool,{id:a.agentId},{endpointId:phone.id,expectedGeneration:'2'});
 const endpointPhone=await authenticateVoiceEndpoint(pool,phoneLogin,phone.token);
 await heartbeatAgentSession(pool,{agentId:a.agentId,sessionId:phone.id,voiceEndpoint:endpointPhone,offline:true});
 assert.equal(await followComputerSelection(pool,a.agentId),null);
 assert.equal((await readVoiceEndpoints(pool,a.agentId)).endpointId,phone.id);
});

test('a selected phone reports its selected registration, not a newer login of the same phone (Codex review on #1642)',async()=>{
 const a=await agent();
 const phoneId=randomUUID(),oldLogin=a.login(),newLogin=a.login();
 const old=await a.register(oldLogin,{kind:'ios',deviceId:phoneId,label:'iPhone'});await a.online(oldLogin,old);
 await chooseVoiceEndpoint(pool,{id:a.agentId},{endpointId:old.id,expectedGeneration:'0'});
 await a.age(old.id,48);
 const current=await a.register(newLogin,{kind:'ios',deviceId:phoneId,label:'iPhone'});await a.online(newLogin,current);
 const phone=(await listVoiceDevices(pool,a.agentId)).devices.find(d=>d.deviceId===phoneId);
 assert.equal(phone.id,old.id,'named by the selected registration');
 assert.equal(phone.selected,true);
 assert.equal(phone.reachable,false,'calls ring the old credential, which is unreachable');
 assert.equal(phone.availability,'unavailable');
 assert.ok(Date.now()-new Date(phone.lastSeenAt).getTime()>24*3600*1000,"last seen is the selected registration, not the newer login (Codex review on #1643)");
});

test('Forget and the sweep release credentials kept by signed-out logins (Codex review on #1642)',async()=>{
 const a=await agent();
 const phoneId=randomUUID(),signedOutLogin=a.login(),newLogin=a.login();
 const signedOut=await a.register(signedOutLogin,{kind:'ios',deviceId:phoneId,label:'iPhone'});
 await revokeAuthVoiceEndpoints(pool,{id:a.agentId},signedOutLogin.authSessionId);
 assert.equal((await pool.query('SELECT credential_id FROM cc_voice_endpoints WHERE id=$1',[signedOut.id])).rows[0].credential_id,`cred-${signedOut.id}`,'a sign-out keeps the credential');
 const current=await a.register(newLogin,{kind:'ios',deviceId:phoneId,label:'iPhone'});await a.online(newLogin,current);
 const released=[];
 await forgetVoiceDevice(pool,{id:a.agentId,authSessionId:randomUUID()},phoneId,{release:async id=>released.push(id)});
 assert.deepEqual(released.sort(),[`cred-${signedOut.id}`,`cred-${current.id}`].sort(),'the signed-out login\'s credential is released too');
 assert.equal((await pool.query('SELECT credential_id FROM cc_voice_endpoints WHERE id=$1',[signedOut.id])).rows[0].credential_id,null);

 // The sweep frees a signed-out credential after an hour, never a fresh one, never the selected one.
 const b=await agent();
 const oldLogin=b.login(),recentLogin=b.login(),selectedLogin=b.login();
 const old=await b.register(oldLogin,{kind:'android',label:'Pixel'});
 const recent=await b.register(recentLogin,{kind:'android',label:'Pixel 2'});
 const selected=await b.register(selectedLogin,{kind:'android',label:'Pixel 3'});await b.online(selectedLogin,selected);
 await chooseVoiceEndpoint(pool,{id:b.agentId},{endpointId:selected.id,expectedGeneration:'0'});
 await pool.query("UPDATE cc_voice_endpoints SET revoked_at=now()-interval '2 hours' WHERE id=ANY($1::uuid[])",[[old.id,selected.id]]);
 await pool.query("UPDATE cc_voice_endpoints SET revoked_at=now() WHERE id=$1",[recent.id]);
 const swept=[];
 const ids=await sweepStaleVoiceEndpoints(pool,{release:async id=>swept.push(id)});
 assert.ok(ids.includes(old.id));
 assert.ok(swept.includes(`cred-${old.id}`),'released after an hour');
 assert.ok(!swept.includes(`cred-${recent.id}`),'a fresh sign-out keeps it (the login may come back)');
 assert.ok(!swept.includes(`cred-${selected.id}`),'the selected registration keeps it');
 assert.equal((await pool.query('SELECT credential_id FROM cc_voice_endpoints WHERE id=$1',[old.id])).rows[0].credential_id,null);
});
