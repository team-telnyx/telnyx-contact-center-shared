import { NextResponse } from "next/server";
import { withWidgetAdmin } from "@/lib/widgets/admin-api";
import { getWidget, updateWidget } from "@/lib/widgets/store";

export const GET=(request,context)=>withWidgetAdmin(request,async({pool})=>{
  const {id}=await context.params;
  const widget=await getWidget(pool,id);
  return NextResponse.json(widget?{widget}:{error:"Widget not found"},{status:widget?200:404});
});
export const PATCH=(request,context)=>withWidgetAdmin(request,async({pool,actor})=>{
  const {id}=await context.params;const body=await request.json();
  return NextResponse.json({widget:await updateWidget(pool,{id,name:body.name,enabled:body.enabled,actor})});
});
