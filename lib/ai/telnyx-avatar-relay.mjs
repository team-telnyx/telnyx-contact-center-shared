import { WebSocket, WebSocketServer } from "ws";
import { getPostgresPool } from "../postgres.mjs";
import { getWidgetSession } from "../widgets/sessions.js";
import { widgetAiRequest } from "../widgets/ai-provider.js";
import { widgetDynamicVariables } from "../widgets/dynamic-variables.js";
import { assertTelnyxAvatarAssistant, usesTelnyxAvatar } from "./telnyx-avatar.mjs";

// Never forward arbitrary session updates or tool results from the visitor.
export function avatarClientFrame(frame) {
  if (frame?.type === "avatar.media.ready" || frame?.type === "response.cancel") return { type: frame.type };
  if (frame?.type === "avatar.webrtc.offer" && frame.offer?.type === "offer" && typeof frame.offer.sdp === "string" && Buffer.byteLength(frame.offer.sdp) > 0 && Buffer.byteLength(frame.offer.sdp) <= 65536) return { type: frame.type, offer: { type: "offer", sdp: frame.offer.sdp } };
  if (frame?.type === "avatar.ice_candidate") {
    const c = frame.candidate;
    if (c === null) return { type: frame.type, candidate: null };
    if (c && typeof c.candidate === "string" && Buffer.byteLength(c.candidate) <= 4096 && ["sdpMid", "usernameFragment"].every((key) => c[key] == null || (typeof c[key] === "string" && c[key].length <= 256)) && (c.sdpMLineIndex == null || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex <= 65535))) return { type: frame.type, candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment } };
  }
  if (frame?.type === "input_audio_buffer.append" && typeof frame.audio === "string" && frame.audio.length <= 64000 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.audio)) {
    const length = Buffer.from(frame.audio, "base64").length;
    if (length > 0 && length % 2 === 0) return { type: frame.type, audio: frame.audio };
  }
  if (frame?.type === "conversation.item.create") {
    const item = frame.item, text = item?.content?.[0]?.text;
    if (item?.type === "message" && item.role === "user" && item.content.length === 1 && item.content[0].type === "input_text" && typeof text === "string" && text.trim() && text.length <= 8000) return { type: frame.type, item: { type: "message", role: "user", content: [{ type: "input_text", text }] } };
  }
  throw new Error("Unsupported avatar frame");
}

export function createTelnyxAvatarRelay({ pool = getPostgresPool, readSession = getWidgetSession, request = widgetAiRequest, apiKey = () => process.env.TELNYX_API_KEY, openUpstream = (url, options) => new WebSocket(url, options) } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const connections = new Set();
  const pendingWrites = new Set();
  const trackWrite = (promise) => {
    pendingWrites.add(promise);
    void promise.then(() => pendingWrites.delete(promise), () => pendingWrites.delete(promise));
    return promise;
  };
  let stopping = false, closePromise;
  wss.on("connection", (client) => {
    let upstream, db, session, authorized = false, claimed = false, ended = false, created = false, alive = true, heartbeatBusy = false;
    let terminalState = "failed";
    let bytes = 0, frames = 0, windowStart = Date.now();
    const persistEnd = () => trackWrite(db.query(`WITH ended AS (UPDATE cc_widget_sessions SET runtime_state=$2,last_seen_at=now() WHERE id=$1 RETURNING conversation_id) UPDATE acd_conversations SET state='closed',closed_at=COALESCE(closed_at,now()) WHERE id IN (SELECT conversation_id FROM ended)`, [session.id, terminalState]));
    const finish = (reason = "Call ended", code = 1000) => {
      if (ended) return;
      ended = true;
      terminalState = created && code === 1000 ? "completed" : "failed";
      clearTimeout(authTimer); clearTimeout(setupTimer); clearInterval(heartbeat); clearTimeout(lifetime);
      connections.delete(finish);
      client.close(code, reason);
      if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate(); else upstream?.close();
      const timer = setTimeout(() => { client.terminate(); upstream?.terminate(); }, 1500); timer.unref();
      if (claimed) void persistEnd().catch(() => {});
    };
    connections.add(finish);
    const authTimer = setTimeout(() => finish("Authentication required", 1008), 5000);
    const setupTimer = setTimeout(() => finish("Avatar preparation timed out", 1011), 75000);
    const lifetime = setTimeout(() => finish("Call duration limit reached"), 30 * 60_000);
    const heartbeat = setInterval(async () => {
      if (ended || heartbeatBusy) return;
      if (!alive) return finish("Visitor disconnected");
      alive = false; client.ping();
      if (!authorized) return;
      heartbeatBusy = true;
      try {
        const current = await readSession(db, session.token);
        if (current.widget_enabled === false || !current.current_config?.channels?.voice?.enabled || ["completed", "failed"].includes(current.runtime_state)) finish("Session access ended");
      } catch { finish("Session access ended"); }
      finally { heartbeatBusy = false; }
    }, 10000);
    client.on("pong", () => { alive = true; });
    client.on("error", () => finish("Visitor connection failed", 1011));
    client.on("close", (code) => {
      if (code === 1000 || code === 1005) finish();
      else finish("Visitor connection failed", 1011);
    });
    client.on("message", async (raw, binary) => {
      if (ended) return;
      try {
        if (binary) throw new Error("Text frames required");
        if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); bytes = 0; frames = 0; }
        bytes += raw.length; frames += 1;
        if (bytes > 256000 || frames > 120) throw new Error("Frame rate exceeded");
        const frame = JSON.parse(raw);
        if (!authorized) {
          if (session || frame.type !== "widget.authenticate" || typeof frame.publicId !== "string") throw new Error("Authentication required");
          // Set before awaiting so concurrent authentication frames cannot race.
          session = {};
          db = pool();
          if (!db || !apiKey()) throw new Error("Unavailable");
          const row = await readSession(db, frame.token);
          if (ended) return;
          if (row.public_id !== frame.publicId || row.runtime_kind !== "ai_voice" || row.runtime_state !== "starting" || row.widget_enabled === false || !usesTelnyxAvatar(row.config) || row.assistant_id !== row.config.channels.voice.assistantId || !row.current_config?.channels?.voice?.enabled) throw new Error("Voice session unavailable");
          session = { ...row, token: frame.token };
          clearTimeout(authTimer);
          const assistant = await request(`/ai/assistants/${encodeURIComponent(row.assistant_id)}`);
          assertTelnyxAvatarAssistant(assistant.data || assistant, row.config.channels.voice, { requireMatch: true });
          if (ended) return;
          claimed = (await trackWrite(db.query("UPDATE cc_widget_sessions SET provider_conversation_id='avatar:starting' WHERE id=$1 AND runtime_state='starting' AND provider_conversation_id IS NULL RETURNING id", [row.id]))).rowCount === 1;
          if (!claimed) throw new Error("Session already used");
          if (ended) {
            await persistEnd();
            return;
          }
          authorized = true;
          clearTimeout(authTimer);
          upstream = openUpstream(`wss://api.telnyx.com/v2/ai/assistants/${encodeURIComponent(row.assistant_id)}/conversation?avatar=true&input_sample_rate=16000`, { headers: { Authorization: `Bearer ${apiKey()}` }, handshakeTimeout: 15000, maxPayload: 1024 * 1024 });
          upstream.on("open", () => {
            if (ended) return;
            upstream.send(JSON.stringify({ type: "session.update", session: { assistant: { dynamic_variables: { ...widgetDynamicVariables(row.context), widget_id: row.public_id, widget_session_id: row.id, widget_origin: row.origin } } } }));
          });
          let delivery = Promise.resolve();
          upstream.on("message", (data) => {
            // Preserve upstream ordering while persisting session.created.
            // The browser may report "active" as soon as it sees this frame.
            delivery = delivery.then(async () => {
              if (ended) return;
              if (client.bufferedAmount > 1024 * 1024) return finish("Playback too slow", 1011);
              const event = JSON.parse(data);
              if (event.type === "session.created") {
                try {
                  const saved = await trackWrite(db.query("UPDATE cc_widget_sessions SET provider_conversation_id=$2,runtime_state='active',last_seen_at=now() WHERE id=$1 AND runtime_state='starting'", [row.id, event.session.conversation_id]));
                  if (saved.rowCount !== 1) return finish("Session service unavailable", 1011);
                } catch { return finish("Session service unavailable", 1011); }
                if (ended) return;
                created = true; clearTimeout(setupTimer);
              }
              if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
              if (event.type === "session.ended") finish();
            }).catch(() => finish("Invalid assistant frame", 1011));
          });
          upstream.on("error", () => finish("Avatar service unavailable", 1011));
          // Process the final session.ended frame first, if one was received.
          upstream.on("close", () => { void delivery.then(() => finish("Assistant disconnected", 1011)); });
          return;
        }
        const allowed = avatarClientFrame(frame);
        if (!created && ["input_audio_buffer.append", "conversation.item.create", "response.cancel"].includes(allowed.type)) throw new Error("Conversation not ready");
        if (upstream?.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 128000) throw new Error("Upstream unavailable");
        upstream.send(JSON.stringify(allowed));
      } catch { finish("Avatar session unavailable", 1008); }
    });
  });
  return {
    upgrade(req, socket, head) {
      if (stopping || connections.size >= 200) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
      wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client));
    },
    close() {
      if (closePromise) return closePromise;
      stopping = true;
      for (const finish of connections) finish("Server stopping", 1001);
      closePromise = Promise.all([
        new Promise(resolve => wss.close(resolve)),
        (async () => {
          // An in-flight claim can enqueue its terminal write after closing.
          while (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
        })(),
      ]).then(() => undefined);
      return closePromise;
    },
  };
}
