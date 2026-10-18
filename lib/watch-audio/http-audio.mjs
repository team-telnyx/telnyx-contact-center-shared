// High-level HTTPS transport for the Watch audio. No recordings on disk.
import { EventEmitter } from 'node:events';

export function createHTTPAudio({ authorized, isBusy, connect, maxBytes = 1024 * 1024 }) {
  const sessions = new Map();
  function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }
  class Client extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    events = [];
    sequence = 0;
    acknowledged = 0;
    inputSequence = 0;
    inputWindow = 1;
    inputs = new Map();
    inputTimer = null;
    lastSeen = Date.now();
    pending = null;
    reason = null;
    send(text) {
      if (this.readyState !== 1) return;
      const bytes = Buffer.byteLength(text);
      if (this.bufferedAmount + bytes > maxBytes) { this.close(1000, 'Playback too slow'); return; }
      this.events.push({ sequence: ++this.sequence, frame: JSON.parse(text), bytes });
      this.bufferedAmount += bytes;
      this.pending?.wake();
    }
    close(_code, reason = 'Call ended') {
      if (this.readyState !== 1) return;
      this.readyState = 3; this.reason = reason;
      clearTimeout(this.inputTimer); this.inputs.clear();
      // Retain final call state until the last poll acknowledges it.
      this.pending?.finish();
      this.emit('close');
    }
    terminate() { this.close(1000, 'Call ended'); }
    ping() { if (Date.now() - this.lastSeen < 15000) this.emit('pong'); }
    poll(req, res, after) {
      if (!Number.isSafeInteger(after) || after < this.acknowledged || after > this.sequence) {
        reply(res, 409); return;
      }
      if (this.pending) { reply(res, 409); return; }
      this.lastSeen = Date.now(); this.acknowledged = after;
      this.events = this.events.filter(event => event.sequence > after);
      this.bufferedAmount = this.events.reduce((sum, event) => sum + event.bytes, 0);
      let timer;
      const finish = () => {
        clearTimeout(timer);
        if (!this.pending) return;
        this.pending = null;
        // Keep unacknowledged events for a repeated GET after a lost response.
        let bytes = 0;
        const batch = this.events.filter(event => {
          if (bytes >= 192 * 1024) return false;
          bytes += event.bytes; return true;
        }).map(({ sequence, frame }) => ({ sequence, frame }));
        reply(res, 200, { events: batch, ended: this.readyState !== 1, reason: this.reason });
      };
      let batching = this.events.length > 0;
      this.pending = { finish, wake: () => {
        if (batching) return;
        batching = true; clearTimeout(timer); timer = setTimeout(finish, 20);
      } };
      timer = setTimeout(finish, batching ? 0 : 800);
      res.on('close', () => { clearTimeout(timer); this.pending = null; });
    }
  }
  async function handle(req, res) {
    if (!req.url?.startsWith('/watch-ai/session/')) return false;
    if (!authorized(req)) { reply(res, 401); return true; }
    const url = new URL(req.url, 'http://localhost');
    const match = /^\/watch-ai\/session\/([a-f0-9-]{36})(?:\/(events|input))?$/.exec(url.pathname);
    if (!match) { reply(res, 404); return true; }
    const [, id, action] = match;
    let client = sessions.get(id);
    if (req.method === 'PUT' && !action) {
      if (client) { reply(res, client.readyState === 1 ? 200 : 410, { inputWindow: client.inputWindow }); return true; }
      if (await isBusy()) { reply(res, 409); return true; }
      // Keep bounded tombstones so retries cannot create a second call with the same ID.
      if (sessions.size >= 20) { reply(res, 429); return true; }
      client = new Client();
      if (req.headers['x-cc-audio-window'] === '4') client.inputWindow = 4;
      sessions.set(id, client);
      try { await connect(client); } catch { client.close(); reply(res, 409); return true; }
      reply(res, 201, { inputWindow: client.inputWindow }); return true;
    }
    if (!client && req.method === 'DELETE' && !action && sessions.size < 20) {
      // Cancellation can overtake creation on another HTTP connection.
      client = new Client(); client.close(); sessions.set(id, client);
      reply(res, 204); return true;
    }
    if (!client) { reply(res, 404); return true; }
    if (req.method === 'DELETE' && !action) { client.close(); reply(res, 204); return true; }
    if (req.method === 'GET' && action === 'events') {
      client.poll(req, res, Number(url.searchParams.get('after') ?? '0')); return true;
    }
    if (req.method === 'POST' && action === 'input') {
      if (client.readyState !== 1) { reply(res, 410); return true; }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024) { reply(res, 413); return true; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks)); } catch { reply(res, 400); return true; }
      if (!Number.isSafeInteger(body.sequence) || body.sequence < 1 || !body.frame) { reply(res, 400); return true; }
      if (body.sequence <= client.inputSequence || client.inputs.has(body.sequence)) { reply(res, 204); return true; }
      if (body.sequence > client.inputSequence + client.inputWindow) { reply(res, 409); return true; }
      // Parallel HTTPS requests may arrive out of order. Replay only contiguous
      // frames, with a four-frame bound and a deadline for missing packets.
      client.inputs.set(body.sequence, body.frame); client.lastSeen = Date.now();
      while (client.readyState === 1 && client.inputs.has(client.inputSequence + 1)) {
        const frame = client.inputs.get(++client.inputSequence);
        client.inputs.delete(client.inputSequence);
        client.emit('message', Buffer.from(JSON.stringify(frame)));
      }
      if (!client.inputs.size) { clearTimeout(client.inputTimer); client.inputTimer = null; }
      else if (!client.inputTimer) {
        client.inputTimer = setTimeout(() => client.close(1000, 'Audio upload interrupted'), 2000);
        client.inputTimer.unref();
      }
      reply(res, client.readyState === 1 ? 204 : 422); return true;
    }
    reply(res, 405); return true;
  }
  return { handle, close: () => { for (const client of sessions.values()) client.close(); } };
}
