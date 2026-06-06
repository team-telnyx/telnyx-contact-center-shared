export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx.js";

const ELEVENLABS_API_KEY_REF = process.env.ELEVENLABS_API_KEY_REF;

export async function POST(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return new NextResponse(
        JSON.stringify({ ok: false, error: "Missing TELNYX_API_KEY" }),
        {
          status: 500,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        }
      );
    }

    const body = await request.json().catch(() => ({}));
    const voice = String(body?.voice || body?.voice_id || "").trim();
    const text = String(body?.text || body?.payload || "").trim();
    const bodyApiKeyRef = String(body?.voice_api_key_ref || "").trim();
    
    // For ElevenLabs, use provided key or fallback to env var
    const voiceApiKeyRef = bodyApiKeyRef || ELEVENLABS_API_KEY_REF || "";

    if (!voice || !text) {
      return new NextResponse(
        JSON.stringify({ ok: false, error: "'voice' and 'text' are required" }),
        {
          status: 400,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        }
      );
    }

    // If using ElevenLabs provider, require API key reference
    if (/^ElevenLabs\./i.test(voice) && !voiceApiKeyRef) {
      return new NextResponse(
        JSON.stringify({
          ok: false,
          error:
            "ElevenLabs voice requires API key. Configure ELEVENLABS_API_KEY_REF in .env or pass voice_api_key_ref.",
        }),
        {
          status: 400,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        }
      );
    }

    const ttsUrl = buildTelnyxV2Url("/text-to-speech/speech");

    const config = {
      voice,
      text,
      voice_settings: {
        ...(voiceApiKeyRef && /^ElevenLabs\./i.test(voice)
          ? { api_key_ref: voiceApiKeyRef }
          : {}),
        voice_speed: body?.voice_speed || 1,
      },
    };

    const upstream = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    });

    if (!upstream.ok) {
      const textErr = await upstream.text();
      return new NextResponse(
        JSON.stringify({
          ok: false,
          error: `Telnyx API error: ${upstream.status} ${textErr}`,
        }),
        {
          status: 502,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        }
      );
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.startsWith("application/json")) {
      const json = await upstream.json().catch(() => ({}));
      return new NextResponse(
        JSON.stringify({
          ok: false,
          error: json?.error || json?.errors || json,
        }),
        {
          status: 502,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        }
      );
    }

    const arrayBuf = await upstream.arrayBuffer();
    // Pass through content type if provided, fallback to audio/mpeg
    const ct = contentType || "audio/mpeg";
    return new NextResponse(Buffer.from(arrayBuf), {
      status: 200,
      headers: {
        "Content-Type": ct,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return new NextResponse(
      JSON.stringify({ ok: false, error: err?.message || String(err) }),
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
      }
    );
  }
}
