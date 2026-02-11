import { NextResponse } from 'next/server';

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

export async function GET(request) {
  try {
    if (!TELNYX_API_KEY) {
      return NextResponse.json({ error: 'TELNYX_API_KEY not configured' }, { status: 500 });
    }

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
    // Result format: { providerId: { modelId: [voices] } }
    const voicesMap = {};
    
    for (const voice of data) {
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

    // Convert to providers array format expected by frontend components
    // Format: [{ id, name, models: [{ id, name, voices: [...] }] }]
    const providers = Object.entries(voicesMap).map(([providerId, models]) => ({
      id: providerId,
      name: providerId,
      provider: providerId,
      models: Object.entries(models).map(([modelId, voices]) => ({
        id: modelId,
        name: modelId,
        voices: voices,
      })),
    }));

    return NextResponse.json({
      ok: true,
      providers: providers,
      voices: voicesMap, // Keep for backwards compatibility
      total: data.length,
    });
  } catch (error) {
    console.error('[TTS Voices] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
