import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { reserveDirectVoice } from "@/lib/acd/direct-capacity.mjs";
import {
  updateNativeAssistant,
  reconcileNativeAssistants,
} from "@/lib/acd/native-assistant.mjs";

export const runtime = "nodejs";
const route = "/api/voice/assistant-session";
export const POST = withPermission(
  "agent:self",
  async (request, _context, authz) => {
    const body = await request.json().catch(() => null);
    if (
      !/^assistant-[a-f0-9-]{36}$/i.test(body?.assistantId || "") ||
      !/^[a-f0-9-]{36}$/i.test(body?.requestId || "")
    )
      return NextResponse.json(
        { error: "Choose an assistant and retry." },
        { status: 400 },
      );
    try {
      const response = await fetch(
        `https://api.telnyx.com/v2/ai/assistants/${body.assistantId}`,
        {
          headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok)
        return NextResponse.json(
          { error: "Assistant unavailable." },
          { status: 503 },
        );
      const json = await response.json(),
        assistant = json.data || json;
      if (!assistant.telephony_settings?.supports_unauthenticated_web_calls)
        return NextResponse.json(
          { error: "WebRTC conversations are not enabled for this assistant." },
          { status: 409 },
        );
      const duration = Number(assistant.telephony_settings?.time_limit_secs);
      if (
        !authz.user.authSessionId ||
        !Number.isInteger(duration) ||
        duration < 1 ||
        duration > 3600
      )
        return NextResponse.json(
          {
            error:
              "Assistant calls require an authenticated device session and a provider call limit of at most one hour.",
          },
          { status: 409 },
        );
      const pool = getPostgresPool();
      await reconcileNativeAssistants(pool);
      const intent = await reserveDirectVoice(pool, {
        agentId: String(authz.user.id),
        requestId: body.requestId,
        target: `sip:user@${body.assistantId}.sip.telnyx.com`,
        nativeAssistantId: body.assistantId,
        nativeSession: {
          authSessionId: authz.user.authSessionId,
          deadline: new Date(
            Date.now() + (duration + 360) * 1000,
          ).toISOString(),
        },
      });
      return NextResponse.json(
        {
          ok: true,
          intentId: intent.id,
          workItemId: intent.work_item_id,
          customHeaders: [{ name: "X-CC-Direct-Intent-Id", value: intent.id }],
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return NextResponse.json(
        {
          error: error.status
            ? error.message
            : "Could not prepare assistant call.",
        },
        { status: error.status || 503 },
      );
    }
  },
  { voiceControl: true, route },
);
export const PATCH = withPermission(
  "agent:self",
  async (request, _context, authz) => {
    const body = await request.json().catch(() => null);
    if (
      !/^[a-f0-9-]{36}$/i.test(body?.id || "") ||
      !["active", "ended"].includes(body?.state)
    )
      return NextResponse.json(
        { error: "Invalid assistant session." },
        { status: 400 },
      );
    try {
      const result = await updateNativeAssistant(
        getPostgresPool(),
        String(authz.user.id),
        { ...body, authSessionId: authz.user.authSessionId },
      );
      return NextResponse.json(
        { ok: true, ...result },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return NextResponse.json(
        {
          error: error.status
            ? error.message
            : "Could not synchronize assistant call.",
        },
        { status: error.status || 503 },
      );
    }
  },
  { route },
);
