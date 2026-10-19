import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer";
import WebSocket, { WebSocketServer } from "ws";
import { defaultRoomsClient } from "./rooms.mjs";
import { conferenceHandoff, endConference, videoEvent } from "./conference.mjs";
import { retireVideoProfiles } from "./ai-profiles.mjs";
import { applyVideoRoomEvent, requestVideoComposition } from "./lifecycle.mjs";
import { composeVideoRecording, pruneOrphanVideoRecordings } from "./recording-compositor.mjs";
import { hasJoinedConferenceAgent } from "./conference-presence.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const safeError = error => String(error?.message || "Video assistant failed").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 400);
export async function startVideoAiWorker(pool, { capacity = Number(process.env.VIDEO_AI_WORKER_CAPACITY || 2), rooms = defaultRoomsClient(), browser: suppliedBrowser, onFailure = () => {} } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) throw new Error("Video worker capacity must be 1–8");
  const owner = `video-ai-${randomUUID()}`, jobs = new Map(), capabilities = new Map();
  let stopping = false, timer, lastMaintenance = 0, maintenance, tickPromise, stopPromise;
  const launches = new Set();
  const maintenanceAbort = new AbortController();
  const controlToken = randomBytes(32).toString("base64url");
  const bundle = await build({ stdin: { contents: 'import {startConferenceBridge} from "./lib/video/conference-bridge.mjs"; window.startConferenceBridge=startConferenceBridge;', resolveDir: ROOT }, bundle: true, write: false, format: "iife", platform: "browser" });
  const worklet = await readFile(new URL("../../public/audio/telnyx-avatar-input.js", import.meta.url));
  const server = http.createServer(async (request, response) => {
    if (request.url === "/image" && request.method === "POST") {
      if (request.headers["x-video-worker-token"] !== controlToken) { response.statusCode = 403; response.end(); return; }
      try {
        const parts = []; let bytes = 0;
        for await (const part of request) { bytes += part.length; if (bytes > 1024 * 1024) throw new Error("Image too large"); parts.push(part); }
        const body = JSON.parse(Buffer.concat(parts)); const job = jobs.get(body.videoSessionId);
        if (!job || job.finishing || String(job.generation) !== body.generation || job.images.size > 0) throw new Error("Session unavailable");
        const { visionImageFrame } = await import("./vision-policy.mjs"); visionImageFrame(body.payload?.imageUrl);
        const id = randomUUID(); job.images.set(id, { id, kind: "image", payload: body.payload, expires: Date.now() + 30000 });
        response.end('{"ok":true}');
      } catch { response.statusCode = 409; response.end('{"error":"Image unavailable"}'); }
      return;
    }
    if (request.url === "/client.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); }
    else if (request.url === "/audio/telnyx-avatar-input.js") { response.setHeader("Content-Type", "text/javascript"); response.end(worklet); }
    else if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><body><script src="/client.js"></script></body></html>'); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(process.env.VIDEO_AI_CONTROL_PORT || 0), process.env.VIDEO_AI_BIND || "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controlUrl = process.env.VIDEO_AI_CONTROL_URL || origin;
  const wss = new WebSocketServer({ server, path: "/conversation", maxPayload: 1024 * 1024 });
  wss.on("connection", down => {
    let upstream, job, authenticated = false, bytes = 0, resetAt = Date.now();
    const toolCalls = new Map();
    let transcript = "";
    const authTimer = setTimeout(() => down.close(1008), 5000);
    down.on("message", raw => {
      try {
        const frame = JSON.parse(raw);
        if (!authenticated) {
          job = capabilities.get(frame.token);
          if (frame.type !== "conference.authenticate" || !job || job.socket) return down.close(1008);
          authenticated = true; clearTimeout(authTimer); job.socket = down;
          const url = `wss://api.telnyx.com/v2/ai/assistants/${encodeURIComponent(job.assistantId)}/conversation?input_sample_rate=16000${job.avatarEnabled ? "&avatar=true" : ""}`;
          upstream = job.upstream = new WebSocket(url, { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 20000 });
          upstream.on("open", () => upstream.send(JSON.stringify({ type: "session.update" })));
          upstream.on("message", data => {
            if (down.readyState !== WebSocket.OPEN) return;
            if (down.bufferedAmount > 2 * 1024 * 1024) return down.close(1013);
            // This handler now shares the application launcher. A malformed
            // provider frame must close its conversation, not crash the app.
            let value;
            try { value = JSON.parse(data); } catch { down.close(1007); return; }
            if (!value || typeof value.type !== "string") { down.close(1007); return; }
            if (value.type === "conversation.item.created" && value.item?.type === "function_call") {
              const item = value.item;
              if (!toolCalls.has(item.call_id)) toolCalls.set(item.call_id, (async () => {
                if (item.name !== "cc_video_handoff") return { error: "unknown_tool" };
                const owned = await pool.query("SELECT 1 FROM cc_video_ai_sessions WHERE video_session_id=$1 AND lease_owner=$2 AND generation=$3 AND lease_until>now() AND desired_state='active'", [job.id, owner, job.generation]);
                if (!owned.rowCount) return { error: "session_expired" };
                let args; try { args = JSON.parse(item.arguments || "{}"); } catch { return { error: "invalid_arguments" }; }
                return conferenceHandoff(pool, { videoSessionId: job.id, summary: args.summary, reason: args.reason });
              })().catch(() => ({ error: "handoff_failed" })));
              void toolCalls.get(item.call_id).then(output => { if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output) } })); });
              return;
            }
            if (value.type === "response.output_audio_transcript.delta") transcript = (transcript + (value.delta || "")).slice(0, 16000);
            if (value.type === "conversation.item.input_audio_transcription.completed" || value.type === "response.done" && transcript) {
              void videoEvent(pool, job.id, "ai.transcript", { role: value.type === "response.done" ? "assistant" : "user", text: value.type === "response.done" ? transcript : String(value.transcript || "").slice(0, 16000) }).catch(() => undefined);
              if (value.type === "response.done") transcript = "";
            }
            down.send(data.toString());
          });
          upstream.on("error", () => down.close(1011)); upstream.on("close", () => down.close(1011));
          return;
        }
        if (Date.now() - resetAt >= 1000) { bytes = 0; resetAt = Date.now(); }
        bytes += raw.byteLength;
        if (bytes > 1400 * 1024 || !["input_audio_buffer.append", "avatar.webrtc.offer", "avatar.ice_candidate", "avatar.media.ready", "conversation.item.create", "response.cancel"].includes(frame.type)) return down.close(1008);
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(raw.toString());
      } catch { down.close(1008); }
    });
    down.on("close", () => { clearTimeout(authTimer); upstream?.close(); }); down.on("error", () => upstream?.close());
  });
  let browser;
  try {
    browser = suppliedBrowser || await puppeteer.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      args: ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-dev-shm-usage"],
      ...(process.env.VIDEO_AI_CHROMIUM_PATH ? { executablePath: process.env.VIDEO_AI_CHROMIUM_PATH } : {}) });
  } catch (error) {
    wss.close(); await new Promise(resolve => server.close(resolve));
    throw error;
  }
  const disconnected = () => { if (!stopping) onFailure(new Error("Video AI Chromium disconnected; restarting media runtime")); };
  browser.once("disconnected", disconnected);
  function finish(job, reason, error) {
    return job.finishPromise ||= finishJob(job, reason, error);
  }
  async function finishJob(job, reason, error) {
    job.finishing = true;
    clearInterval(job.renewTimer); capabilities.delete(job.capability);
    job.socket?.close(); job.upstream?.close(); job.images.clear();
    await job.context?.close().catch(() => undefined);
    const failed = !["stopped", "shutdown"].includes(reason);
    const updated = await pool.query(`UPDATE cc_video_ai_sessions SET state=$4,error=$5,lease_owner=NULL,lease_until=NULL,ended_at=now(),updated_at=now()
      WHERE video_session_id=$1 AND lease_owner=$2 AND generation=$3 RETURNING *`, [job.id, owner, job.generation, reason === "shutdown" ? "pending" : failed ? "failed" : "stopped", error ? safeError(error) : failed ? reason : null]);
    jobs.delete(job.id);
    if (updated.rowCount && failed) {
      await videoEvent(pool, job.id, "ai.failed", { reason });
      await conferenceHandoff(pool, { videoSessionId: job.id, reason: "ai_unavailable" }).catch(() => undefined);
    }
  }
  async function launch(row) {
    const job = { id: row.video_session_id, generation: row.generation, capability: randomBytes(32).toString("base64url"), assistantId: row.assistant_id, avatarEnabled: row.config.avatar.enabled, images: new Map(), lastReport: Date.now(), launchedAt: Date.now() };
    jobs.set(job.id, job); capabilities.set(job.capability, job);
    if (stopping) return finish(job, "shutdown");
    job.renewTimer = setInterval(async () => {
      try {
        if (Date.now() - job.lastReport > (job.ready ? 15000 : 85000)) return await finish(job, "media_unresponsive");
        const result = await pool.query("UPDATE cc_video_ai_sessions SET lease_until=now()+interval '20 seconds' WHERE video_session_id=$1 AND lease_owner=$2 AND generation=$3", [job.id, owner, job.generation]);
        if (!result.rowCount) await finish(job, "lease_lost");
      } catch (error) { await finish(job, "lease_unavailable", error).catch(() => undefined); }
    }, 5000);
    try {
      job.context = await browser.createBrowserContext();
      if (stopping || job.finishing) { await job.context.close(); return; }
      job.page = await job.context.newPage();
      let lastRefresh = Date.now(), lastRoomSync = 0, join = await rooms.generateJoinToken(row.room_id);
      const readState = async report => {
        const current = (await pool.query(`SELECT a.*,v.state AS video_state,v.work_item_id FROM cc_video_ai_sessions a JOIN acd_video_sessions v ON v.id=a.video_session_id
          WHERE a.video_session_id=$1 AND a.lease_owner=$2 AND a.generation=$3 AND a.lease_until>now()`, [job.id, owner, job.generation])).rows[0];
        if (!current || stopping || ["ended", "failed"].includes(current.video_state) || current.desired_state === "stopped") return { stop: true };
        let assignments = [];
        if (current.work_item_id) {
          assignments = (await pool.query("SELECT agent_id FROM acd_text_assignments WHERE work_item_id=$1 AND state='active'", [current.work_item_id])).rows;
          // Revoke a transferred-away agent before any further audio or frames.
          await pool.query("UPDATE cc_video_members SET revoked_at=now(),consent='{}'::jsonb WHERE video_session_id=$1 AND role='agent' AND revoked_at IS NULL AND NOT(principal_id=ANY($2::text[]))", [job.id, assignments.map(a => a.agent_id)]);
        }
        const members = (await pool.query(`SELECT m.id,m.role,m.participant_id,m.consent,CASE WHEN m.role='agent' THEN NULLIF(concat_ws(' ',u.first_name,u.last_name),'') ELSE c.customer_name END AS name
          FROM cc_video_members m JOIN acd_video_sessions v ON v.id=m.video_session_id JOIN acd_conversations c ON c.id=v.conversation_id
          LEFT JOIN users u ON m.role='agent' AND u.id=m.principal_id WHERE m.video_session_id=$1 AND m.revoked_at IS NULL AND m.participant_id IS NOT NULL`, [job.id])).rows;
        if (assignments.length && !current.vision.humanJoined && hasJoinedConferenceAgent(members, report?.participants)) {
          if (!row.started_with_agent) current.desired_state = row.config.afterAgentJoins === "leave" ? "stopped" : row.config.afterAgentJoins;
          current.vision.humanJoined = true;
          await pool.query("UPDATE cc_video_ai_sessions SET desired_state=$2,vision=vision||'{\"humanJoined\":true}'::jsonb WHERE video_session_id=$1 AND lease_owner=$3 AND generation=$4", [job.id, current.desired_state, owner, job.generation]);
        }
        if (report) {
          if (!job.ready) await videoEvent(pool, job.id, "ai.connected", {startupMs:Date.now()-job.launchedAt,avatarEnabled:job.avatarEnabled});
          await pool.query("UPDATE acd_video_sessions SET started_at=COALESCE(started_at,now()),state=CASE WHEN work_item_id IS NULL AND state='waiting' THEN 'active' ELSE state END WHERE id=$1",[job.id]);
          job.ready = true; job.lastReport = Date.now();
          if (Date.now() - lastRoomSync > 30000) {
            lastRoomSync = Date.now();
            const providerRoom = await rooms.getRoom(row.room_id).catch(() => null);
            if (providerRoom?.active_session_id) await pool.query("UPDATE acd_video_sessions SET room_session_id=$2 WHERE id=$1 AND room_session_id IS NULL", [job.id, providerRoom.active_session_id]);
          }
          await pool.query(`UPDATE cc_video_ai_sessions SET state=$4,provider_conversation_id=$5,sources=$6::jsonb,
            vision=vision||$7::jsonb,started_at=COALESCE(started_at,now()),updated_at=now() WHERE video_session_id=$1 AND lease_owner=$2 AND generation=$3`,
          [job.id, owner, job.generation, report.fallback ? "audio_only" : "connected", report.providerConversationId, JSON.stringify(report.sources), JSON.stringify({ effectiveSourceKey: report.effectiveSourceKey, transitionUntil: report.transitionUntil, uploadStage: report.uploadStage || null })]);
          if (report.fallback && !job.fallbackRecorded && job.avatarEnabled) {
            job.fallbackRecorded = true; await videoEvent(pool, job.id, "ai.audio_fallback", { reason: String(report.fallbackReason || "Avatar media failed").slice(0, 400) });
          }
        }
        for (const [id, image] of job.images) if (image.expires < Date.now()) job.images.delete(id);
        const commands = [...job.images.values(), ...(await pool.query("SELECT id,kind,payload FROM cc_video_ai_commands WHERE video_session_id=$1 AND completed_at IS NULL AND expires_at>now() ORDER BY created_at LIMIT 1", [job.id])).rows].slice(0, 1);
        if (Date.now() - lastRefresh > 10 * 60 * 1000) {
          join = await rooms.refreshJoinToken(row.room_id, join.refreshToken); lastRefresh = Date.now();
          await job.page.evaluate(token => window.conferenceRefreshToken?.(token), join.token);
          await videoEvent(pool, job.id, "ai.token_renewed", {generation: String(job.generation)});
        }
        return { stop: current.desired_state === "stopped", desiredState: current.desired_state, members, vision: current.vision, visionConfig: row.config.vision, commands };
      };
      await job.page.exposeFunction("conferenceHostState", readState);
      await job.page.exposeFunction("conferenceHostComplete", commandId => job.images.delete(commandId) ? true : pool.query("UPDATE cc_video_ai_commands SET payload='{}'::jsonb,completed_at=now() WHERE id=$1 AND video_session_id=$2", [commandId, job.id]).then(() => true));
      await job.page.exposeFunction("conferenceHostStopped", reason => { setTimeout(() => void finish(job, reason).catch(() => undefined), 0); return true; });
      await job.page.goto(origin);
      const state = await readState();
      await job.page.evaluate(config => window.startConferenceBridge(config), { roomId: row.room_id, token: join.token, name: row.config.avatar.name || "AI assistant", avatarEnabled: job.avatarEnabled,
        relayUrl: origin.replace("http:", "ws:") + "/conversation", capability: job.capability, state });
    } catch (error) { await finish(job, "startup_failed", error); }
  }
  async function tick() {
    if (stopping) return;
    try {
      if (!maintenance && Date.now() - lastMaintenance > 60000) {
        lastMaintenance = Date.now();
        maintenance = (async () => {
          await retireVideoProfiles(pool);
          await pruneOrphanVideoRecordings(pool);
          const pending = (await pool.query(`WITH jobs AS (SELECT id FROM acd_video_sessions
            WHERE state='ended' AND recording_enabled AND room_session_id IS NOT NULL AND composition_id IS NULL
            AND (composition_state IS NULL OR composition_state='awaiting_recordings') AND updated_at<now()-interval '30 seconds'
            ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 2)
            UPDATE acd_video_sessions v SET composition_state='requesting',updated_at=now() FROM jobs j WHERE v.id=j.id RETURNING v.*`)).rows;
          for (const session of pending) await requestVideoComposition(pool, session, { rooms });
          const composing = (await pool.query(`SELECT v.* FROM acd_video_sessions v WHERE v.state='ended' AND v.recording_enabled
            AND EXISTS(SELECT 1 FROM cc_video_ai_sessions a WHERE a.video_session_id=v.id)
            AND v.composition_state IN ('enqueued','processing','failed','composing_local')
            AND v.composition_local_attempts<2 AND v.updated_at<now()-interval '30 seconds' ORDER BY v.updated_at LIMIT 2`)).rows;
          for (const session of composing) {
            const remote = session.composition_id ? await rooms.getComposition(session.composition_id).catch(() => null) : null;
            if (remote?.status === 'completed') await applyVideoRoomEvent(pool, {eventType:'video.room.composition.completed',eventId:`video-composition:${remote.id}`,payload:{composition_id:remote.id}}, {rooms});
            else if (!stopping && (Date.now()-new Date(session.updated_at).getTime()>300000 || remote?.status==='failed')) await composeVideoRecording(pool, session, {rooms, signal:maintenanceAbort.signal}).catch(() => undefined);
          }
          const expired = (await pool.query(`SELECT v.id FROM acd_video_sessions v WHERE v.work_item_id IS NULL AND v.state NOT IN ('ended','failed')
            AND EXISTS(SELECT 1 FROM cc_widget_sessions s WHERE s.conversation_id=v.conversation_id AND (s.expires_at<now() OR s.runtime_state IN ('completed','failed'))) LIMIT 20`)).rows;
          for (const video of expired) { if (stopping) break; await endConference(pool, video.id, { rooms }); }
        })().catch(error => console.error('[video-ai-maintenance]', safeError(error))).finally(() => { maintenance = null; });
      }
      await pool.query(`INSERT INTO cc_video_ai_workers(id,capacity,active,control_url,control_token) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET active=$3,heartbeat_at=now()`, [owner, capacity, jobs.size, controlUrl, controlToken]);
      await pool.query("DELETE FROM cc_video_ai_commands WHERE expires_at<now() OR completed_at IS NOT NULL");
      // Expired visitors and terminal ACD work must not leave a billable bot.
      await pool.query(`UPDATE cc_video_ai_sessions a SET desired_state='stopped' FROM acd_video_sessions v WHERE v.id=a.video_session_id AND
        (v.state IN ('ended','failed') OR EXISTS(SELECT 1 FROM cc_widget_sessions s WHERE s.conversation_id=v.conversation_id AND (s.expires_at<now() OR s.runtime_state IN ('completed','failed'))))`);
      if (jobs.size < capacity) {
        const claimed = (await pool.query(`WITH candidate AS (
          SELECT a.video_session_id FROM cc_video_ai_sessions a JOIN acd_video_sessions v ON v.id=a.video_session_id
          WHERE a.desired_state<>'stopped' AND a.state NOT IN ('failed','stopped') AND v.room_id IS NOT NULL AND v.state NOT IN ('ended','failed')
          AND (a.lease_until IS NULL OR a.lease_until<now()) ORDER BY a.created_at FOR UPDATE OF a SKIP LOCKED LIMIT $2
        ), claimed AS (UPDATE cc_video_ai_sessions a SET lease_owner=$1,lease_until=now()+interval '20 seconds',generation=generation+1,state='starting',ended_at=NULL
          FROM candidate c WHERE a.video_session_id=c.video_session_id RETURNING a.*)
        SELECT a.*,v.room_id,p.assistant_id,p.config,EXISTS(SELECT 1 FROM acd_text_assignments x WHERE x.work_item_id=v.work_item_id AND x.state='active') AS started_with_agent
        FROM claimed a JOIN acd_video_sessions v ON v.id=a.video_session_id JOIN cc_video_ai_profiles p ON p.id=a.profile_id`, [owner, capacity - jobs.size])).rows;
        for (const row of claimed) {
          const launching = launch(row).catch(() => undefined).finally(() => launches.delete(launching));
          launches.add(launching);
        }
      }
    } catch (error) { console.error("[video-ai-worker]", safeError(error)); }
    if (!stopping) timer = setTimeout(() => { tickPromise = tick(); }, 2000);
  }
  tickPromise = tick();
  return { owner, jobs, stop() { return stopPromise ||= stop(); } };
  async function stop() {
    stopping = true; clearTimeout(timer); maintenanceAbort.abort();
    browser.off("disconnected", disconnected);
    await tickPromise;
    await Promise.allSettled([...jobs.values()].map(job => finish(job, "shutdown")));
    await Promise.allSettled(launches);
    await maintenance;
    for (const socket of wss.clients) socket.terminate(); wss.close(); await new Promise(resolve => server.close(resolve));
    if (!suppliedBrowser) await browser.close();
    await pool.query("DELETE FROM cc_video_ai_workers WHERE id=$1", [owner]);
  }
}
