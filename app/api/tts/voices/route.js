import { NextResponse } from 'next/server';

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

export async function GET(request) {
  try {
    if (!TELNYX_API_KEY) {
      return NextResponse.json({ error: 'TELNYX_API_KEY not configured' }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const language = searchParams.get('language') || 'en';

    const response = await fetch('https://api.telnyx.com/v2/text-to-speech/voices', {
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Telnyx API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Parse voices into provider/model/voice structure
    const voicesMap = {};
    
    for (const voice of data) {
      // Filter by language if specified
      if (language && voice.language && !voice.language.toLowerCase().startsWith(language.toLowerCase())) {
        continue;
      }
      
      const provider = voice.provider || 'unknown';
      const model = voice.model_id || 'default';
      
      if (!voicesMap[provider]) {
        voicesMap[provider] = {};
      }
      if (!voicesMap[provider][model]) {
        voicesMap[provider][model] = [];
      }
      
      voicesMap[provider][model].push({
        id: voice.id,
        name: voice.name,
        label: voice.label || voice.name,
        language: voice.language,
        gender: voice.gender,
        age: voice.age,
      });
    }

    return NextResponse.json({
      ok: true,
      voices: voicesMap,
      total: data.length,
    });
  } catch (error) {
    console.error('[TTS Voices] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
