import { WebSocket, WebSocketServer } from "ws";
import { avatarClientFrame } from "./telnyx-avatar-relay.mjs";
import { readAssistantCallSession, authorizeAssistantCaller, assistantCallSettings, WORKFLOW_TEST_SCOPE } from "./assistant-call-session.mjs";
import { widgetAiRequest } from "../widgets/ai-provider.js";
import { assertTelnyxAvatarAssistant } from "./telnyx-avatar.mjs";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

const logger = createDiagnosticLogger("telnyx.assistant-call");

// Actionable copy for documented Telnyx conversation WebSocket error codes.
// Telnyx's own message text is not forwarded (it is not localized and may
// change); unknown codes keep the generic message.
const UPSTREAM_ERROR_MESSAGES = {
  unsupported_voice_output_format: "This assistant's voice streams compressed audio, which Telnyx does not support for web calls over WebSocket. Choose a voice with PCM output (for example a Telnyx NaturalHD or Ultra voice) and try again.",
  ingress_budget_exceeded: "Audio was sent faster than Telnyx accepts. Try again.",
  session_not_ready: "The assistant was not ready for audio yet. Try again.",
};
export function upstreamErrorMessage(error) {
  return UPSTREAM_ERROR_MESSAGES[error?.code] || "Telnyx could not start or continue the conversation. Check the saved assistant settings and try again.";
}

// The internal Call button never uses anonymous WebRTC login. Both voice and
// avatar conversations authenticate to Telnyx with the server's account key.
export function createAssistantCallRelay({ readSession = readAssistantCallSession, authorize = authorizeAssistantCaller, request = widgetAiRequest, apiKey = () => process.env.TELNYX_API_KEY, openUpstream = (url, options) => new WebSocket(url, options), heartbeatMs = 10000 } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const connections = new Set();
  let stopping = false;
  wss.on("connection", (client, req) => {
    let upstream, claims, authenticating = false, authorized = false, created = false, ended = false, alive = true, checking = false;
    let bytes = 0, frames = 0, windowStart = Date.now(), congestedAt = 0;
    let phase = "authorization";
    const finish = (message = "Call ended", code = 1000) => {
      if (ended) return;
      ended = true;
      clearTimeout(authTimer); clearTimeout(setupTimer); clearTimeout(lifetime); clearInterval(heartbeat);
      connections.delete(finish);
      if (code !== 1000 && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", error: { message } }));
      client.close(code, message.slice(0, 120));
      if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate(); else upstream?.close();
      const timer = setTimeout(() => { client.terminate(); upstream?.terminate(); }, 1500); timer.unref();
    };
    connections.add(finish);
    const authTimer = setTimeout(() => finish("Sign in to Contact Center and try again.", 1008), 5000);
    const setupTimer = setTimeout(() => finish("The assistant took too long to connect. Try again.", 1011), 75000);
    const lifetime = setTimeout(() => finish("The test call reached its 30-minute limit.", 1000), 30 * 60_000);
    const heartbeat = setInterval(async () => {
      if (ended || checking) return;
      if (!alive) return finish();
      alive = false; client.ping();
      if (!authorized) return;
      checking = true;
      try { await authorize(claims); } catch { finish("Your Contact Center session or call permission has ended. Sign in again.", 1008); }
      finally { checking = false; }
    }, heartbeatMs);
    client.on("pong", () => { alive = true; });
    client.on("error", () => finish("The call connection was interrupted. Try again.", 1011));
    client.on("close", () => finish());
    client.on("message", async (raw, binary) => {
      if (ended) return;
      try {
        if (binary) throw new Error("Unsupported call message");
        if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); bytes = 0; frames = 0; }
        bytes += raw.length; frames++;
        if (bytes > 256000 || frames > 120) throw new Error("Too many call messages");
        const frame = JSON.parse(raw);
        if (!authorized) {
          if (authenticating || frame.type !== "assistant.call.authenticate") throw new Error("Call authorization required");
          authenticating = true;
          claims = readSession(frame.token, req.headers.origin);
          await authorize(claims);
          if (ended) return;
          phase = "assistant-settings";
          clearTimeout(authTimer);
          if (!apiKey()) return finish("Telnyx credentials are not configured in Contact Center.", 1011);
          const response = await request(`/ai/assistants/${encodeURIComponent(claims.assistantId)}`);
          const assistant = response.data || response, config = assistantCallSettings(assistant);
          // Workflow tests are always voice-only, whatever avatar the assistant has saved.
          const workflowTest = claims.scope === WORKFLOW_TEST_SCOPE, avatar = workflowTest ? null : config.avatar;
          if (!workflowTest && JSON.stringify(config.avatar) !== JSON.stringify(claims.avatar)) return finish("The assistant changed. Close and reopen Call.", 1008);
          if (avatar) assertTelnyxAvatarAssistant(assistant, { avatar });
          if (ended) return;
          authorized = true;
          phase = "conversation";
          const params = new URLSearchParams({ input_sample_rate: "16000", ...(avatar ? { avatar: "true" } : {}) });
          upstream = openUpstream(`wss://api.telnyx.com/v2/ai/assistants/${encodeURIComponent(claims.assistantId)}/conversation?${params}`, { headers: { Authorization: `Bearer ${apiKey()}` }, handshakeTimeout: 15000, maxPayload: 1024 * 1024 });
          upstream.on("open", () => {
            if (ended) return;
            // Avatars require this frame and do not start until media is ready.
            if (avatar) upstream.send(JSON.stringify({ type: "session.update", session: { assistant: { dynamic_variables: { cc_user_id: claims.userId, cc_call_source: "assistant-configurator" } } } }));
            // Voice-only conversations start on their own after a short grace
            // period; a session.update sent as the very first frame starts them
            // at once and tags the Telnyx conversation with the test context
            // (verified live on 2026-10-17, see the workflow voice test report).
            else if (workflowTest) upstream.send(JSON.stringify({ type: "session.update", session: { assistant: { dynamic_variables: { cc_user_id: claims.userId, cc_call_source: "workflow-test", cc_workflow_id: claims.workflowId } } } }));
          });
          upstream.on("message", (data) => {
            if (ended) return;
            try {
              if (client.bufferedAmount > 1024 * 1024) return finish("The call connection is too slow. Try again.", 1011);
              const event = JSON.parse(data);
              if (event.type === "session.created") { created = true; clearTimeout(setupTimer); }
              if (event.type === "error") {
                // Telnyx reports the natural end of a started conversation (the
                // assistant hung up, or the session timed out) as an error frame.
                // That is a normal end for the caller, not a failure.
                if (created && ["conversation_ended", "session_idle_timeout", "session_max_duration_exceeded"].includes(event.error?.code)) {
                  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "session.ended", reason: event.error.code }));
                  return finish();
                }
                logger.warn("assistant_call_upstream_error", { phase, started: created, code: typeof event.error?.code === "string" ? event.error.code.slice(0, 64) : null });
                return finish(upstreamErrorMessage(event.error), 1011);
              }
              if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
              if (event.type === "session.ended") finish();
            } catch { finish("The assistant returned an invalid response. Try again.", 1011); }
          });
          upstream.on("unexpected-response", (_request, response) => {
            response.resume();
            finish([401, 403].includes(response.statusCode) ? "Telnyx rejected the Contact Center credentials. Ask an administrator to check the Telnyx connection." : "The Telnyx conversation service is unavailable. Try again shortly.", 1011);
          });
          upstream.on("error", () => finish("Could not reach the Telnyx conversation service. Try again.", 1011));
          upstream.on("close", () => finish("The assistant disconnected. You can start a new call.", 1011));
          return;
        }
        const allowed = avatarClientFrame(frame);
        if (!claims.avatar && allowed.type.startsWith("avatar.")) throw new Error("Avatar is not enabled");
        if (!created && ["input_audio_buffer.append", "conversation.item.create", "response.cancel"].includes(allowed.type)) throw new Error("Call is not ready");
        if (upstream?.readyState !== WebSocket.OPEN) throw new Error("Assistant transport closed");
        if (upstream.bufferedAmount > 128000) {
          // Do not accumulate stale microphone audio or end an authenticated
          // session because a transient network/CPU stall fills the write queue.
          if (allowed.type === "input_audio_buffer.append") {
            congestedAt ||= Date.now();
            if (Date.now() - congestedAt > 15000) finish("Audio could not reach the assistant. Check your network and try again.", 1011);
            return;
          }
          throw new Error("Assistant transport congested");
        }
        congestedAt = 0;
        upstream.send(JSON.stringify(allowed));
      } catch (error) {
        logger.warn("assistant_call_rejected", { phase, reason: error.message });
        const message = phase === "assistant-settings"
          ? "Could not load the assistant from Telnyx. Try again shortly."
          : authorized ? "The call connection was interrupted. Check your network and try again." : "Could not authorize this call. Reopen Call and try again.";
        finish(message, phase === "assistant-settings" ? 1011 : 1008);
      }
    });
  });
  return {
    upgrade(req, socket, head) {
      if (stopping || connections.size >= 200) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
      wss.handleUpgrade(req, socket, head, client => wss.emit("connection", client, req));
    },
    async close() { stopping = true; for (const finish of connections) finish(); await new Promise(resolve => wss.close(resolve)); },
  };
}
