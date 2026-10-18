import { createWatchOutbound } from './outbound.mjs';
import { watchAudioURL } from './sessions.mjs';
import { WebSocket, WebSocketServer } from 'ws';
import { createHTTPAudio } from './http-audio.mjs';
import { CALL_LIMIT_MS, watchAudioStore } from './sessions.mjs';
import { getPostgresPool } from '../postgres.mjs';

// One maintained streaming worker serves both transports; tokens are scoped to
// one user, assistant and call, never the Telnyx account. No media is persisted.
export function createWatchAudioRelay({ store, apiKey = () => process.env.TELNYX_API_KEY,
  openUpstream = (url, options) => new WebSocket(url, options), maxCalls = 20,
  heartbeatMs = 10_000, callLimitMs = CALL_LIMIT_MS } = {}) {
  const repository = () => store || watchAudioStore(getPostgresPool());
  const httpSessions = new Map(), active = new Map();
  const outbound=createWatchOutbound({repository,apiKey,heartbeatMs,callLimitMs});
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  let closing = false;
  const reply = (res,status) => { res.writeHead(status, {'Cache-Control':'no-store'}); res.end(); };
  const enabled = () => !closing && !!apiKey() && Number(process.env.WATCH_AUDIO_RELAY_REPLICAS || 1) === 1;
  const sweep = setInterval(() => {
    for (const [id, entry] of httpSessions) if (entry.expires < Date.now() && !active.has(id)) {
      entry.transport.close(); httpSessions.delete(id);
    }
  }, 30_000); sweep.unref();

  async function connect(client, ticket) {
    if (!enabled() || active.size >= maxCalls) throw new Error('Unavailable');
    // Reserve locally before awaiting PG, and atomically across all client transports.
    if (active.has(ticket.id)) throw new Error('Already connected');
    active.set(ticket.id, { close: () => client.close(1001,'Server stopping') });
    let claimed = false;
    try {
      claimed = await repository().claim(ticket.id);
      if (!claimed || closing || client.readyState !== 1) throw new Error('Session unavailable');
      if(ticket.target) {
        const call=outbound.bridge(client,{...ticket,media_url:watchAudioURL()},()=>active.delete(ticket.id));
        active.set(ticket.id,call);
      } else bridge(client, ticket);
    } catch (error) {
      active.delete(ticket.id);
      if (claimed) await repository().end(ticket.id).catch(() => {});
      throw error;
    }
  }
  function bridge(client,ticket) {
    let upstream;
    try {
      upstream = openUpstream(`wss://api.telnyx.com/v2/ai/assistants/${encodeURIComponent(ticket.assistant_id)}/conversation?input_sample_rate=16000&output_sample_rate=24000`,
        { headers: { Authorization: `Bearer ${apiKey()}` }, handshakeTimeout: 15_000, maxPayload: 1024 * 1024 });
    } catch { client.close(1011,'Assistant unavailable'); throw new Error('Assistant unavailable'); }
    let finished = false, alive = true, checking = false;
    const finish = reason => {
      if (finished) return; finished = true;
      clearTimeout(deadline); clearInterval(heartbeat);
      client.close(1000,reason);
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate(); else upstream.close();
      const terminate = setTimeout(() => { client.terminate(); upstream.terminate(); }, 2000); terminate.unref();
      // End the lease after initiating upstream closure; no new call is started automatically.
      repository().end(ticket.id).catch(() => {}).finally(() => active.delete(ticket.id));
    };
    const deadline = setTimeout(() => finish('Call duration limit reached'), callLimitMs); deadline.unref();
    const heartbeat = setInterval(async () => {
      if (checking || finished) return;
      if (!alive) return finish('Watch disconnected');
      alive = false; client.ping(); checking = true;
      try { if (!await repository().heartbeat(ticket.id)) finish('Session access ended'); }
      catch { finish('Session service unavailable'); }
      finally { checking = false; }
    }, heartbeatMs); heartbeat.unref();
    active.set(ticket.id,{ close: () => finish('Server stopping') });
    client.on('pong', () => { alive = true; });
    upstream.on('open', () => { if (!finished) upstream.send(JSON.stringify({type:'session.update'})); });
    upstream.on('message', data => {
      if (finished) return;
      if (client.bufferedAmount > 1024 * 1024) return finish('Playback too slow');
      try {
        JSON.parse(data);
        if (client.readyState === 1) client.send(data.toString());
      } catch { finish('Invalid assistant frame'); }
    });
    client.on('message', data => {
      if (finished) return;
      try {
        const frame = JSON.parse(data);
        if (frame.type === 'input_audio_buffer.append' && typeof frame.audio === 'string' &&
            frame.audio.length <= 90000 && /^[A-Za-z0-9+/]+={0,2}$/.test(frame.audio)) {
          const pcm = Buffer.from(frame.audio,'base64');
          if (!pcm.length || pcm.length % 2) return finish('Invalid audio');
          if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 128 * 1024) return finish('Upload too slow');
          upstream.send(JSON.stringify({ type:frame.type, audio:frame.audio }));
        } else if (frame.type === 'response.cancel' && upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({type:frame.type}));
        } else finish('Unsupported audio message');
      } catch { finish('Invalid audio frame'); }
    });
    client.on('close', () => finish('Call ended'));
    client.on('error', () => finish('Watch connection failed'));
    upstream.on('close', () => finish('Assistant disconnected'));
    upstream.on('error', () => finish('Assistant unavailable'));
  }
  return {
    async handle(req,res) {
      if (!new URL(req.url,'http://localhost').pathname.startsWith('/watch-ai/')) return false;
      if (!enabled()) { reply(res,503); return true; }
      try {
        const ticket = await repository().authorize(req);
        if (!ticket) { reply(res,401); return true; }
        if (req.url === '/watch-ai/ready' && req.method === 'DELETE') {
          active.get(ticket.id)?.close();
          await repository().end(ticket.id);
          reply(res,204); return true;
        }
        if (req.url === '/watch-ai/ready' && req.method === 'GET') {
          reply(res,ticket.state === 'issued' && active.size < maxCalls ? 204 : 409); return true;
        }
        let entry = httpSessions.get(ticket.id);
        if (!entry) {
          if (httpSessions.size >= 200) { reply(res,429); return true; }
          const transport = createHTTPAudio({ authorized: () => true,
            isBusy: () => active.has(ticket.id) || active.size >= maxCalls,
            connect: client => connect(client,ticket) });
          entry = { transport, expires: new Date(ticket.expires_at).getTime() };
          httpSessions.set(ticket.id,entry);
        }
        if (!await entry.transport.handle(req,res)) reply(res,404);
      } catch { if (!res.headersSent) reply(res,503); else res.end(); }
      return true;
    },
    async upgrade(req,socket,head) {
      if(new URL(req.url,"http://localhost").pathname.startsWith("/watch-ai/media/")) {outbound.upgrade(req,socket,head);return;}
      try {
        const ticket = enabled() && await repository().authorize(req);
        if (!ticket || ticket.state !== 'issued' || active.size >= maxCalls) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
        }
        wss.handleUpgrade(req,socket,head,client => {
          client.on('error',() => {});
          connect(client,ticket).catch(() => client.close(1008,'Session unavailable'));
        });
      } catch { socket.destroy(); }
    },
    close() {
      closing = true; clearInterval(sweep); outbound.close();
      for (const session of active.values()) session.close();
      for (const entry of httpSessions.values()) entry.transport.close();
      httpSessions.clear(); wss.close();
    },
  };
}
