import { NextResponse } from 'next/server';
import { withPermission } from '@/lib/authz/guard';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { issueWatchAudioTicket } from '@/lib/watch-audio/sessions.mjs';

export const runtime = 'nodejs';
export const POST = withPermission('authenticated', async (request, _context, authz) => {
  const body = await request.json().catch(() => null);
  if (!/^assistant-[a-f0-9-]{36}$/.test(body?.assistantId || ''))
    return NextResponse.json({ error: 'Choose an AI assistant.' }, { status: 400 });
  if (!process.env.TELNYX_API_KEY) return NextResponse.json({ error: 'AI audio is not configured.' }, { status: 503 });
  try {
    // The directory exposes this account's assistants to signed-in users. Verify
    // the selected ID in the same Telnyx account before granting any media access.
    const response = await fetch(`https://api.telnyx.com/v2/ai/assistants/${body.assistantId}`, {
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return NextResponse.json({ error: 'Assistant unavailable.' }, { status: response.status === 404 ? 404 : 503 });
    const ticket = await issueWatchAudioTicket(getPostgresPool(), authz.user, body.assistantId);
    return NextResponse.json(ticket, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error.status || 503;
    return NextResponse.json({ error: status < 500 ? error.message : 'AI audio is temporarily unavailable.' }, { status });
  }
}, { route: '/api/mobile/v1/watch/audio-session' });
