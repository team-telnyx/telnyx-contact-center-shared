// Telnyx Video Rooms REST client. Server-only: the API key never reaches a
// browser; clients receive short-lived join tokens instead.
// Verified against the live API on 2026-09-17 (spike in
// ~/Documents/dev/telnyx-video-rooms-spike): recordings are per participant
// (audio and video separately), compositions are mp4 h264 and carry sound only
// when `audio_sources: ["*"]` is sent, download URLs are presigned for one hour.
import { buildTelnyxV2Url } from "../telnyx.js";

const DEFAULT_RESOLUTION = { width: 1280, height: 720 };
export const COMPOSITION_LAYOUTS = Object.freeze(["pip", "split"]);

export class VideoRoomsError extends Error {
  constructor(message, { status = 502, detail = null, providerStatus = null } = {}) {
    super(message);
    this.name = "VideoRoomsError";
    this.status = status;
    this.detail = detail;
    this.providerStatus = providerStatus;
  }
}

// Region layout for the composed recording. `main` is the customer, `secondary`
// the agent. Telnyx limits a composition to two regions, which is exactly one
// picture-in-picture or one side-by-side arrangement.
export function compositionLayout(kind, { main, secondary = null } = {}, { width, height } = DEFAULT_RESOLUTION) {
  if (!main) throw new VideoRoomsError("A composition needs at least one video recording", { status: 400 });
  if (!secondary) {
    return { main: { video_sources: [main], x_pos: 0, y_pos: 0, width, height, z_pos: 0 } };
  }
  if (kind === "split") {
    const half = Math.floor(width / 2);
    return {
      left: { video_sources: [main], x_pos: 0, y_pos: 0, width: half, height, z_pos: 0 },
      right: { video_sources: [secondary], x_pos: half, y_pos: 0, width: width - half, height, z_pos: 0 },
    };
  }
  const pipWidth = Math.round(width / 4), pipHeight = Math.round(height / 4), margin = 24;
  return {
    main: { video_sources: [main], x_pos: 0, y_pos: 0, width, height, z_pos: 0 },
    pip: { video_sources: [secondary], x_pos: width - pipWidth - margin, y_pos: height - pipHeight - margin, width: pipWidth, height: pipHeight, z_pos: 1 },
  };
}

function unwrap(body) {
  return body && typeof body === "object" && "data" in body ? body.data : body;
}

export function createRoomsClient({ apiKey = process.env.TELNYX_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  async function request(method, path, body) {
    if (!apiKey) throw new VideoRoomsError("Telnyx API key is not configured", { status: 503 });
    const response = await fetchImpl(buildTelnyxV2Url(path), {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!response.ok) {
      const detail = json?.errors?.[0]?.detail || json?.errors?.[0]?.title || text.slice(0, 300);
      throw new VideoRoomsError(`Telnyx video ${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ""}`,
        { status: response.status === 404 ? 404 : 502, detail: json, providerStatus: response.status });
    }
    return unwrap(json);
  }

  return {
    createRoom({ uniqueName, enableRecording = true, webhookUrl = null, maxParticipants = 4 } = {}) {
      return request("POST", "/rooms", {
        unique_name: uniqueName,
        max_participants: maxParticipants,
        enable_recording: Boolean(enableRecording),
        ...(webhookUrl ? { webhook_event_url: webhookUrl, webhook_timeout_secs: 20 } : {}),
      });
    },
    getRoom(roomId) { return request("GET", `/rooms/${encodeURIComponent(roomId)}`); },
    deleteRoom(roomId) { return request("DELETE", `/rooms/${encodeURIComponent(roomId)}`); },
    async generateJoinToken(roomId, { tokenTtlSecs = 900, refreshTokenTtlSecs = 3600 } = {}) {
      const data = await request("POST", `/rooms/${encodeURIComponent(roomId)}/actions/generate_join_client_token`,
        { token_ttl_secs: tokenTtlSecs, refresh_token_ttl_secs: refreshTokenTtlSecs });
      return { token: data.token, refreshToken: data.refresh_token, expiresAt: data.token_expires_at || null, refreshExpiresAt: data.refresh_token_expires_at || null };
    },
    async refreshJoinToken(roomId, refreshToken, { tokenTtlSecs = 900 } = {}) {
      const data = await request("POST", `/rooms/${encodeURIComponent(roomId)}/actions/refresh_client_token`,
        { refresh_token: refreshToken, token_ttl_secs: tokenTtlSecs });
      return { token: data.token, refreshToken: data.refresh_token || refreshToken, expiresAt: data.token_expires_at || null };
    },
    getSession(sessionId) { return request("GET", `/room_sessions/${encodeURIComponent(sessionId)}?include_participants=true`); },
    endSession(sessionId) { return request("POST", `/room_sessions/${encodeURIComponent(sessionId)}/actions/end`, {}); },
    kickParticipants(sessionId, participants = "all") {
      return request("POST", `/room_sessions/${encodeURIComponent(sessionId)}/actions/kick`, { participants });
    },
    listRecordings({ sessionId, roomId } = {}) {
      const filter = sessionId ? `filter[session_id]=${encodeURIComponent(sessionId)}` : `filter[room_id]=${encodeURIComponent(roomId)}`;
      return request("GET", `/room_recordings?${filter}&page[size]=50`);
    },
    getRecording(recordingId) { return request("GET", `/room_recordings/${encodeURIComponent(recordingId)}`); },
    // `audio_sources: ["*"]` is undocumented in the OpenAPI spec but required:
    // without it the mp4 has no audio track. The API accepts only "*" or null.
    createComposition({ sessionId, layout = "pip", main, secondary = null, resolution = DEFAULT_RESOLUTION, webhookUrl = null, includeAudio = true } = {}) {
      return request("POST", "/room_compositions", {
        session_id: sessionId,
        format: "mp4",
        resolution: `${resolution.width}x${resolution.height}`,
        video_layout: compositionLayout(layout, { main, secondary }, resolution),
        ...(includeAudio ? { audio_sources: ["*"] } : {}),
        ...(webhookUrl ? { webhook_event_url: webhookUrl, webhook_timeout_secs: 20 } : {}),
      });
    },
    getComposition(compositionId) { return request("GET", `/room_compositions/${encodeURIComponent(compositionId)}`); },
  };
}

let defaultClient = null;
export function defaultRoomsClient() {
  if (!defaultClient) defaultClient = createRoomsClient();
  return defaultClient;
}
