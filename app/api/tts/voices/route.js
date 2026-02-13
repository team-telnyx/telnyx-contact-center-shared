import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const url = new URL(request.url);
    const provider = url.searchParams.get("provider");
    const elevenLabsRef =
      url.searchParams.get("elevenlabs_api_key_ref") ||
      process.env.ELEVENLABS_API_KEY_REF ||
      null;

    const sp = new URLSearchParams();
    if (provider) sp.set("provider", provider);
    if (elevenLabsRef) sp.set("elevenlabs_api_key_ref", elevenLabsRef);

    const res = await fetch(
      buildTelnyxV2Url(`/text-to-speech/voices?${sp.toString()}`),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();
    const voices = Array.isArray(data?.voices) ? data.voices : [];

    // Normalize to { providers: [{ id, name, models: [{ id, name, voices: [...] }] }] }
    const byProviderModel = new Map();
    for (const v of voices) {
      const providerName = String(v?.provider || "").trim();
      // Try to extract model and voiceName from id or name
      // Expect formats like Provider.Model.VoiceId
      const idStr = String(v?.id || v?.name || "");
      const parts = idStr.split(".");
      const inferredProvider = (parts[0] || providerName || "").trim();
      const model = parts.length >= 3 ? parts[1] : "";
      const groupKey = `${inferredProvider}::${model}`;
      if (!byProviderModel.has(groupKey)) {
        byProviderModel.set(groupKey, {
          provider: inferredProvider,
          model,
          voices: [],
        });
      }
      byProviderModel.get(groupKey).voices.push({
        id: v.id,
        name: v.name,
        label: v.label || v.name,
        language: v.language,
        gender: v.gender,
        age: v.age,
      });
    }

    const providersMap = new Map();
    for (const { provider: prov, model, voices: list } of byProviderModel.values()) {
      if (!providersMap.has(prov)) {
        providersMap.set(prov, {
          id: prov,
          name: prov,
          models: [],
        });
      }
      providersMap.get(prov).models.push({ id: model, name: model, voices: list });
    }
    
    const providers = Array.from(providersMap.values()).map((p) => ({
      ...p,
      models: p.models.sort((a, b) => a.name.localeCompare(b.name)),
    }));

    return NextResponse.json(
      { ok: true, providers, total: voices.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[TTS Voices] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
