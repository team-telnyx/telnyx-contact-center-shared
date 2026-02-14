import { NextResponse } from 'next/server';
import { buildTelnyxV2Url } from "@/lib/telnyx.js";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const ELEVENLABS_API_KEY_REF = process.env.ELEVENLABS_API_KEY_REF;

export async function POST(request) {
  try {
    const body = await request.json();
    const { text, voice = 'Telnyx.NaturalHD.astra', voice_api_key_ref } = body;
    
    if (!text) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }
    
    if (!TELNYX_API_KEY) {
      return NextResponse.json({ error: 'TELNYX_API_KEY not configured' }, { status: 500 });
    }
    
    // Check if ElevenLabs voice
    const isElevenLabs = /^ElevenLabs\./i.test(voice);
    
    // For ElevenLabs, api_key_ref is required (ignore empty strings)
    const apiKeyRef = (voice_api_key_ref && voice_api_key_ref.trim()) || ELEVENLABS_API_KEY_REF;
    if (isElevenLabs && !apiKeyRef) {
      return NextResponse.json({ 
        error: 'ElevenLabs voice requires api_key_ref. Configure ELEVENLABS_API_KEY_REF or pass voice_api_key_ref.' 
      }, { status: 400 });
    }
    
    console.log(`[TTS] Generating audio for: "${text.substring(0, 50)}..." with voice: ${voice}`);
    
    // Build request config
    const config = {
      voice,
      text,
    };
    
    // Add voice_settings for ElevenLabs
    if (isElevenLabs) {
      config.voice_settings = {
        api_key_ref: apiKeyRef,
        voice_speed: 1,
      };
    }
    
    const ttsUrl = buildTelnyxV2Url("/text-to-speech/speech");
    
    const upstream = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    });
    
    if (!upstream.ok) {
      const textErr = await upstream.text();
      console.error(`[TTS] Telnyx API error: ${upstream.status}`, textErr);
      return NextResponse.json({ 
        error: `TTS server error: ${upstream.status}` 
      }, { status: upstream.status });
    }
    
    const contentType = upstream.headers.get("content-type") || "";
    
    // Check if response is JSON (error)
    if (contentType.startsWith("application/json")) {
      const json = await upstream.json().catch(() => ({}));
      console.error('[TTS] Unexpected JSON response:', json);
      return NextResponse.json({ 
        error: json?.error || json?.errors || 'Unexpected response' 
      }, { status: 502 });
    }
    
    const arrayBuf = await upstream.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuf);
    
    if (!audioBuffer || audioBuffer.length === 0) {
      return NextResponse.json({ error: 'No audio generated' }, { status: 500 });
    }
    
    console.log(`[TTS] Generated ${audioBuffer.length} bytes of audio`);
    
    return new NextResponse(audioBuffer, {
      headers: {
        'Content-Type': contentType || 'audio/mpeg',
        'Content-Length': audioBuffer.length.toString(),
      },
    });
    
  } catch (error) {
    console.error('[TTS] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
