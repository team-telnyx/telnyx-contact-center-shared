import {createHmac, timingSafeEqual} from 'node:crypto';
import {agentJoinToken, refreshJoinToken, readVideoSession} from './lifecycle.mjs';

const fail=(message,status=403)=>Object.assign(new Error(message),{status});
function secret() {
 const key=process.env.NEXTAUTH_SECRET;
 if(!key)throw fail('Video screen sharing is not configured',503);
 return key;
}
function signature(payload) {return createHmac('sha256',secret()).update('cc-video-screen-v1:'+payload).digest('base64url');}
export function signScreenGrant(claims, now=Date.now()) {
 const payload=Buffer.from(JSON.stringify({...claims,exp:Math.floor(now/1000)+3600})).toString('base64url');
 return payload+'.'+signature(payload);
}
export function verifyScreenGrant(value, now=Date.now()) {
 if(typeof value!=='string'||value.length>4096)throw fail('Invalid screen capability');
 const parts=value.split('.');
 if(parts.length!==2)throw fail('Invalid screen capability');
 const expected=Buffer.from(signature(parts[0]));const actual=Buffer.from(parts[1]);
 if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw fail('Invalid screen capability');
 let claims;try{claims=JSON.parse(Buffer.from(parts[0],'base64url').toString());}catch{throw fail('Invalid screen capability');}
 if(!claims.workItemId||!claims.agentId||!claims.assignmentId||!claims.roomId||!Number.isFinite(claims.exp)||claims.exp<=now/1000)throw fail('Screen capability expired');
 return claims;
}
export async function createMobileScreenGrant(pool,{workItemId,agentId,rooms}) {
 const assignment=(await pool.query("SELECT a.segment_id AS id,s.media_endpoint_id FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id WHERE a.work_item_id=$1 AND a.agent_id=$2 AND a.state='active'",[workItemId,agentId])).rows[0];
 if(!assignment)throw fail('Accept this video interaction first');
 const join=await agentJoinToken(pool,{workItemId,agentId,...(rooms?{rooms}:{})});
 return {join,screenCapability:signScreenGrant({workItemId,agentId,assignmentId:assignment.id,roomId:join.roomId,endpointId:assignment.media_endpoint_id||null})};
}
export async function validateMobileScreenGrant(pool,capability) {
 const claims=verifyScreenGrant(capability);
 const owned=await pool.query(`SELECT 1 FROM acd_text_assignments a JOIN acd_work_items w ON w.id=a.work_item_id JOIN acd_segments s ON s.id=a.segment_id
   WHERE a.segment_id=$1 AND a.work_item_id=$2 AND a.agent_id=$3 AND a.state='active' AND w.channel='video' AND w.terminal_at IS NULL AND s.media_endpoint_id IS NOT DISTINCT FROM $4::uuid`,[claims.assignmentId,claims.workItemId,claims.agentId,claims.endpointId||null]);
 if(!owned.rowCount)throw fail('Screen sharing assignment has ended');
 const session=await readVideoSession(pool,claims.workItemId);
 if(!session||session.room_id!==claims.roomId||['ended','failed','abandoned'].includes(session.state))throw fail('Video session has ended');
 return claims;
}
export async function refreshMobileScreenGrant(pool,{capability,refreshToken},rooms) {
 const claims=await validateMobileScreenGrant(pool,capability);
 return refreshJoinToken(pool,{workItemId:claims.workItemId,agentId:claims.agentId,refreshToken,...(rooms?{rooms}:{})});
}
