import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readTextInteractions } from "@/lib/acd/text-desktop.mjs";
import { loadNotificationSoundsForUser } from "@/lib/contact-center/notification-sounds.mjs";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(){
  const user=await getAuthenticatedUser();if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  // The agent's own sound choices, falling back to the system settings.
  const [desktop, sounds] = await Promise.all([readTextInteractions(pool,String(user.id)), loadNotificationSoundsForUser(pool,String(user.id))]);
  return NextResponse.json({...desktop, notificationSounds: sounds.effective},{headers:{"Cache-Control":"no-store"}});
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/chat" });
