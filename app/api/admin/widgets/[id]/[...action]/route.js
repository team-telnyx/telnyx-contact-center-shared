import { NextResponse } from "next/server";
import { withWidgetAdmin } from "@/lib/widgets/admin-api";
import { boundedMultipart } from "@/lib/widgets/attachments";
import { getWidget, preflightWidget, publishWidget, restoreWidgetRevision, updateWidgetDraft, widgetAudit } from "@/lib/widgets/store";

async function handle(request,context){
  return withWidgetAdmin(request,async({pool,actor})=>{
    const {id,action}=await context.params;
    const path=action.join("/");
    if(path==="draft"&&request.method==="PUT")return NextResponse.json({widget:await updateWidgetDraft(pool,{...await request.json(),id,actor})});
    if(path==="publish/preflight"&&request.method==="POST"){
      const {widget}=await preflightWidget(pool,id);
      return NextResponse.json({draftId:widget.draft.id,editVersion:widget.draft.editVersion,conflicts:[],changes:[]});
    }
    if(path==="publish"&&request.method==="POST"){
      const body=await request.json();
      const widget=await publishWidget(pool,{...body,id,actor});
      if(!body.stream)return NextResponse.json({widget});
      const lines=[{type:"progress",progress:{status:"success",label:"Publish widget",detail:`Revision ${widget.published.version} is live`}},{type:"result",result:{widget}}];
      return new Response(lines.map(line=>JSON.stringify(line)).join("\n")+"\n",{headers:{"Content-Type":"application/x-ndjson","Cache-Control":"no-store"}});
    }
    if(path==="revisions"&&request.method==="GET"){
      const rows=(await pool.query("SELECT id,version,state,created_at,published_at FROM cc_widget_revisions WHERE widget_id=$1 AND state<>'draft' ORDER BY version DESC",[id])).rows;
      const audit=(await pool.query("SELECT actor_id,action,details,created_at FROM cc_widget_audit WHERE widget_id=$1 ORDER BY id DESC LIMIT 100",[id])).rows;
      return NextResponse.json({revisions:rows,audit});
    }
    if(path==="restore"&&request.method==="POST")return NextResponse.json({widget:await restoreWidgetRevision(pool,{...await request.json(),id,actor})});
    if(path==="preview-background"){
      if(!await getWidget(pool,id))return NextResponse.json({error:"Widget not found"},{status:404});
      const variant=new URL(request.url).searchParams.get("variant")||"";
      if(!/^[a-z0-9][a-z0-9_-]{0,80}$/i.test(variant))return NextResponse.json({error:"Invalid preview variant"},{status:400});
      if(request.method==="GET"){
        const asset=(await pool.query("SELECT bytes FROM cc_widget_preview_assets WHERE widget_id=$1 AND variant=$2",[id,variant])).rows[0];
        return asset?new Response(asset.bytes,{headers:{"Content-Type":"image/webp","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}}):NextResponse.json({error:"Screenshot not found"},{status:404});
      }
      if(request.method==="DELETE"){
        await pool.query("DELETE FROM cc_widget_preview_assets WHERE widget_id=$1 AND variant=$2",[id,variant]);
        await widgetAudit(pool,id,actor,"widget.preview.deleted",{variant});
        return NextResponse.json({deleted:true});
      }
      if(request.method==="POST"){
        const file=(await boundedMultipart(request,8*1048576)).get("file");
        if(!file||typeof file.arrayBuffer!=="function"||file.size>8*1048576)return NextResponse.json({error:"Upload a WebP screenshot up to 8 MB"},{status:400});
        const bytes=Buffer.from(await file.arrayBuffer());
        if(bytes.subarray(0,4).toString()!=="RIFF"||bytes.subarray(8,12).toString()!=="WEBP")return NextResponse.json({error:"Invalid WebP screenshot"},{status:400});
        await pool.query(`INSERT INTO cc_widget_preview_assets(widget_id,variant,bytes) VALUES($1,$2,$3)
          ON CONFLICT(widget_id,variant) DO UPDATE SET bytes=$3,updated_at=now()`,[id,variant,bytes]);
        await widgetAudit(pool,id,actor,"widget.preview.updated",{variant});
        return NextResponse.json({url:`/api/admin/widgets/${id}/preview-background?variant=${encodeURIComponent(variant)}&v=${Date.now()}`});
      }
    }
    return NextResponse.json({error:"Unknown widget operation"},{status:404});
  });
}
export const GET=handle;
export const POST=handle;
export const PUT=handle;
export const DELETE=handle;
