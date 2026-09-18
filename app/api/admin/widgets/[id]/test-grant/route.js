import { NextResponse } from "next/server";
import { withWidgetAdmin } from "@/lib/widgets/admin-api";
import { createWidgetTestGrant } from "@/lib/widgets/session-tokens";
import { getWidget, widgetAudit } from "@/lib/widgets/store";

// Grant for the widget test page. The loader calls the public bootstrap
// without cookies, so the page proves the signed-in user through this grant.
// It is bound to one widget and to the origin of this request, which
// withWidgetAdmin has already verified to be the application's own.
export const POST=(request,context)=>withWidgetAdmin(request,async({pool,actor,user})=>{
  const {id}=await context.params;
  const widget=await getWidget(pool,id);
  if(!widget)return NextResponse.json({error:"Widget not found"},{status:404});
  if(!widget.published||!widget.enabled)return NextResponse.json({error:"Publish and enable the widget before testing it"},{status:409});
  const origin=request.headers.get("origin")||new URL(request.url).origin;
  await widgetAudit(pool,id,actor,"widget.test.opened",{origin});
  return NextResponse.json({publicId:widget.publicId,grant:createWidgetTestGrant({publicId:widget.publicId,origin,userId:user.id})},{headers:{"Cache-Control":"no-store"}});
},{permission:"widgets:read"});
