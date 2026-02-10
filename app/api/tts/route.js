import { NextResponse } from 'next/server';
import WebSocket from 'ws';

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

export async function POST(request) {
  try {
    const { text, voice = 'Minimax.speech-2.8-turbo.English_magnetic_voiced_man' } = await request.json();
    
    if (!text) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }
    
    if (!TELNYX_API_KEY) {
      return NextResponse.json({ error: 'TELNYX_API_KEY not configured' }, { status: 500 });
    }
    
    console.log(`[TTS] Generating audio for: "${text.substring(0, 50)}..." with voice: ${voice}`);
    
    const audioBuffer = await generateTTS(text, voice);
    
    if (!audioBuffer || audioBuffer.length === 0) {
      return NextResponse.json({ error: 'No audio generated' }, { status: 500 });
    }
    
    console.log(`[TTS] Generated ${audioBuffer.length} bytes of audio`);
    
    return new NextResponse(audioBuffer, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length.toString(),
      },
    });
    
  } catch (error) {
    console.error('[TTS] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function generateTTS(text, voice) {
  return new Promise((resolve, reject) => {
    const url = `wss://api.telnyx.com/v2/text-to-speech/speech?voice=${encodeURIComponent(voice)}`;
    
    const ws = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`
      }
    });
    
    const audioChunks = [];
    let timeout;
    
    ws.on('open', () => {
      console.log('[TTS] WebSocket connected');
      
      // Send initialization frame
      ws.send(JSON.stringify({ text: ' ' }));
      
      // Send text frame
      ws.send(JSON.stringify({ text: text }));
      
      // Send stop frame
      ws.send(JSON.stringify({ text: '' }));
      
      // Timeout after 30 seconds
      timeout = setTimeout(() => {
        ws.close();
        resolve(Buffer.concat(audioChunks));
      }, 30000);
    });
    
    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        // Collect audio
        if (response.audio) {
          const audioData = Buffer.from(response.audio, 'base64');
          audioChunks.push(audioData);
        }
        
        // Final frame
        if (response.isFinal) {
          clearTimeout(timeout);
          ws.close();
          resolve(Buffer.concat(audioChunks));
        }
      } catch (e) {
        console.error('[TTS] Message parse error:', e);
      }
    });
    
    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.error('[TTS] WebSocket error:', error);
      reject(error);
    });
    
    ws.on('close', () => {
      clearTimeout(timeout);
      console.log('[TTS] WebSocket closed');
      resolve(Buffer.concat(audioChunks));
    });
  });
}
