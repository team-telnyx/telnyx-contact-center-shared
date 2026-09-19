import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readConversationSnapshot } from "@/lib/acd/conversation-preview.mjs";
import { withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";

export const dynamic = "force-dynamic";
async function GET_handler(request, context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  const { id } = await context.params;
  const params = new URL(request.url).searchParams;
  try {
    const resume = request.headers.get("last-event-id");
    // Non-participants read a conversation with an elevated grant inside their data scope.
    const supervisor = Boolean(authz.elevated) && (await workItemInScope(pool, authz.scope, id));
    const initial = await readConversationSnapshot(pool, {
      workItemId: id,
      user,
      supervisor,
      before: params.get("before"),
      after: resume && /^\d+$/.test(resume) ? resume : undefined,
      refreshSnapshot: true,
    });
    if (params.get("stream") !== "1")
      return NextResponse.json(initial, {
        headers: { "Cache-Control": "private, no-store" },
      });
    const encoder = new TextEncoder();
    let timer,
      stopped = false;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
    };
    const stream = new ReadableStream({
      start(controller) {
        let cursor = initial.cursor,
          ticks = 0;
        const send = (value) =>
          controller.enqueue(
            encoder.encode(
              `id: ${value.cursor}\nevent: conversation\ndata: ${JSON.stringify(value)}\n\n`,
            ),
          );
        send(initial);
        const tick = async () => {
          try {
            // Revalidate the user and work scope on each refresh; no long-lived impersonation.
            const { PgDb } = await import("@/lib/pgdb");
            const currentUser = await PgDb.findUserById(String(user.id));
            if (!currentUser || currentUser.active === false)
              throw new Error("Access expired");
            const next = await readConversationSnapshot(pool, {
              workItemId: id,
              user: currentUser,
              supervisor,
              after: cursor,
              refreshSnapshot: ++ticks % 15 === 0,
            });
            if (stopped) return;
            cursor = next.cursor;
            if (next.snapshot) send(next);
            else controller.enqueue(encoder.encode(": keepalive\n\n"));
            timer = setTimeout(tick, 1000);
          } catch {
            if (!stopped) {
              stop();
              controller.error(new Error("Conversation refresh unavailable"));
            }
          }
        };
        request.signal.addEventListener(
          "abort",
          () => {
            stop();
            try {
              controller.close();
            } catch {}
          },
          { once: true },
        );
        timer = setTimeout(tick, 1000);
      },
      cancel: stop,
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "private, no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.status ? error.message : "Conversation unavailable" },
      { status: error.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission(["agent:self", "interactions:read"], GET_handler, { elevated: ["monitor:read", "interactions_history:read", "quality:read", "quality_evaluations:read"], route: "/api/contact-center/interactions/[id]/conversation" });
