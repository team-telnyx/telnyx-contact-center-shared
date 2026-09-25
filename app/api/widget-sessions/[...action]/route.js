import { updateWidgetVoiceState } from "@/lib/widgets/ai-sessions";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { bearerToken,verifyAttachmentAccessToken,widgetSessionToken } from "@/lib/widgets/session-tokens";
import { getWidgetSession,readWidgetConversation,actAsWidgetCustomer } from "@/lib/widgets/sessions";
import { attachmentResponse,receiveTextAttachment } from "@/lib/widgets/attachments";
import { videoWidgetJoin,videoWidgetLeave,videoWidgetRefreshToken,videoWidgetState } from "@/lib/widgets/video-sessions";
import { consentWidgetCobrowse,readWidgetCobrowse } from "@/lib/cobrowse/lifecycle.mjs";

async function handle(request,context){
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Service unavailable"},{status:503});
  try{
    const {action}=await context.params;const path=action.join("/");const token=bearerToken(request);
    if(path==="cobrowse-state"&&request.method==="GET")return NextResponse.json({session:await readWidgetCobrowse(pool,{token,clientKey:request.headers.get("x-cobrowse-tab")})},{headers:{"Cache-Control":"no-store"}});
    if(path==="cobrowse/consent"&&request.method==="POST"){
      const body=await request.json().catch(()=>({}));
      if(typeof body.accepted!=="boolean")return NextResponse.json({error:"Decision required"},{status:400});
      return NextResponse.json(await consentWidgetCobrowse(pool,{token,clientKey:request.headers.get("x-cobrowse-tab"),accepted:body.accepted}),{headers:{"Cache-Control":"no-store"}});
    }
    if(path === "voice-state" && ["GET","POST"].includes(request.method)) {
      return NextResponse.json(await updateWidgetVoiceState(pool,token,request.method === "POST" ? await request.json() : null),{headers:{"Cache-Control":"no-store"}});
    }
    if(path==="video-state"&&request.method==="GET")return NextResponse.json(await videoWidgetState(pool,token),{headers:{"Cache-Control":"no-store"}});
    if(path==="video/join"&&request.method==="POST")return NextResponse.json(await videoWidgetJoin(pool,token),{headers:{"Cache-Control":"no-store"}});
    if(path==="video/token"&&request.method==="POST"){const body=await request.json().catch(()=>({}));return NextResponse.json(await videoWidgetRefreshToken(pool,token,{refreshToken:body.refreshToken}),{headers:{"Cache-Control":"no-store"}});}
    if(path==="video/leave"&&request.method==="POST")return NextResponse.json(await videoWidgetLeave(pool,token),{headers:{"Cache-Control":"no-store"}});
    if(request.method==="GET"&&action[0]==="attachments"&&action.length===2){
      let claims;try{claims=verifyAttachmentAccessToken(new URL(request.url).searchParams.get("access"),{attachmentId:action[1]});}
      catch{return NextResponse.json({error:"Attachment link expired"},{status:401});}
      const session=await getWidgetSession(pool,widgetSessionToken(claims.s));
      const file=(await pool.query("SELECT * FROM acd_text_attachments WHERE id=$1 AND conversation_id=$2",[action[1],session.conversation_id])).rows[0];
      return file?attachmentResponse(request,file):NextResponse.json({error:"Attachment not found"},{status:404});
    }
    if(request.method==="POST"&&path==="attachments"){
      const session=await getWidgetSession(pool,token);
      const result=await receiveTextAttachment(pool,{token,request});
      const state=await readWidgetConversation(pool,session);
      return NextResponse.json({...state,message:state.messages.find(message=>message.id===result.clientId)||null,storedMessageId:result.messageId});
    }
    if(request.method==="GET"&&["state","messages"].includes(path)){
      const session=await getWidgetSession(pool,token);
      return NextResponse.json(await readWidgetConversation(pool,session),{headers:{"Cache-Control":"no-store"}});
    }
    if(request.method==="POST"&&["messages","typing","disconnect"].includes(path)){
      const body=path==="disconnect"?{}:await request.json();
      return NextResponse.json(await actAsWidgetCustomer(pool,{token,action:path==="messages"?"send":path,
        content:body.content,messageId:body.messageId,typing:body.typing}),{headers:{"Cache-Control":"no-store"}});
    }
    return NextResponse.json({error:"Unknown widget operation"},{status:404});
  }catch(error){return NextResponse.json({error:error.status?error.message:"Chat request failed"},{status:error.status||500});}
}
export const GET=handle;
export const POST=handle;
