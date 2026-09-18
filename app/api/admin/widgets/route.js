import { listWidgetAssistants } from "@/lib/widgets/ai-provider";
import { NextResponse } from "next/server";
import { withWidgetAdmin } from "@/lib/widgets/admin-api";
import { createWidget, listWidgets } from "@/lib/widgets/store";

export const GET=request=>withWidgetAdmin(request,async({pool,user})=>{
  const widgets=await listWidgets(pool);
  const queues=(await pool.query(`SELECT q.id,q.name FROM cc_queues q JOIN cc_queue_channels c ON c.queue_id=q.id
    WHERE q.enabled=true AND c.channel='chat' AND c.enabled=true ORDER BY q.name`)).rows;
  let assistants=[], inventoryError=null;
  try { assistants=await listWidgetAssistants(); } catch(error) { inventoryError=error.message; }
  return NextResponse.json({widgets,queues,assistants,inventoryError,user:{id:user.id,name:[user.first_name,user.last_name].filter(Boolean).join(" ")||user.username}},{headers:{"Cache-Control":"no-store"}});
});
export const POST=request=>withWidgetAdmin(request,async({pool,actor})=>{
  const body=await request.json();
  return NextResponse.json({widget:await createWidget(pool,{name:body.name,cloneFromId:body.cloneFromId,actor})},{status:201});
});
