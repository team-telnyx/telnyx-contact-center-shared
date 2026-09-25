import {
  ensureAgentState,
  setAgentPresence,
} from "./agent-state.mjs";
import { appendEvent } from "./events.mjs";
import { NATIVE_LIFECYCLE_CHANNELS } from "./channel-registry.mjs";

// Any true capability keeps a session online; the predicate is data-driven so
// a newly released text channel needs no SQL change.
const ANY_CAPABILITY = (column) => `EXISTS (SELECT 1 FROM jsonb_each_text(${column}) cap WHERE cap.value = 'true')`;
const TEXT_ROLES = ["agent", "admin", "owner", "supervisor"];

export async function heartbeatAgentSession(
  pool,
  {
    agentId,
    sessionId,
    deviceId = null,
    voiceReady = false,
    voiceEndpoint = null,
    pushReady = false,
    videoPushReady = false,
    chatReady = false,
    emailReady = false,
    ready: readyChannels = {},
    offline = false,
    node = "web",
  },
) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId || "")) {
    throw Object.assign(new Error("Invalid session id"), { status: 400 });
  }
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await ensureAgentState(tx, agentId);
    await tx.query("SELECT agent_id FROM acd_agent_state WHERE agent_id=$1 FOR UPDATE", [agentId]);
    const preference=(await tx.query("SELECT endpoint_id FROM cc_agent_voice_preferences WHERE agent_id=$1",[agentId])).rows[0];
    let leaseSeconds=45;
    let endpointReady=false;
    if (voiceEndpoint) {
      if (sessionId !== voiceEndpoint.id) throw Object.assign(new Error("Endpoint session mismatch"), {status:403});
      const fresh=(await tx.query("SELECT * FROM cc_voice_endpoints WHERE id=$1 AND revoked_at IS NULL",[voiceEndpoint.id])).rows[0];
      if (!fresh || fresh.secret_hash !== voiceEndpoint.secret_hash) throw Object.assign(new Error("Voice endpoint revoked"),{status:403});
      // A push lease requires a recent SDK registration and a current PushKit token.
      const mobilePush = pushReady && !offline && fresh.kind==='ios' && (voiceReady || (fresh.ready && new Date(fresh.expires_at)>new Date()));
      const registered = mobilePush && (await tx.query(`SELECT 1 FROM cc_mobile_devices WHERE device_id=$1 AND user_id=$2 AND voip_token IS NOT NULL`,[fresh.device_id,agentId])).rowCount>0;
      const videoAlert = videoPushReady && !offline && fresh.kind === 'ios' &&
        (await tx.query(`SELECT 1 FROM cc_mobile_devices d JOIN users u ON u.id=d.user_id
          WHERE d.device_id=$1 AND d.user_id=$2 AND d.alert_token IS NOT NULL
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(u.refresh_tokens,'[]'::jsonb)) s WHERE s->>'sessionId'=d.auth_session_id)`,
        [fresh.device_id,agentId])).rowCount > 0;
      leaseSeconds=registered || videoAlert ? 3600 : 45;
      endpointReady=!offline && (voiceReady || registered);
      await tx.query(`UPDATE cc_voice_endpoints SET ready=$2,push_ready=$3,expires_at=now()+make_interval(secs=>$4) WHERE id=$1`,[fresh.id,!offline && voiceReady,Boolean(registered),registered ? 3600 : 45]);
    }
    const identity = (
      await tx.query(
        "SELECT telephony_credentials_id, roles FROM users WHERE id = $1",
        [agentId],
      )
    ).rows[0];
    if (!identity) throw Object.assign(new Error("Agent not found"), { status: 404 });
    const policies = (await tx.query("SELECT channel,enabled FROM cc_agent_channel_policies WHERE agent_id=$1 AND channel=ANY($2::text[])",
      [agentId, NATIVE_LIFECYCLE_CHANNELS])).rows;
    const textRole = (identity.roles || []).some(role => TEXT_ROLES.includes(role));
    const readyFlags = { chat: chatReady === true, email: emailReady === true, ...(readyChannels && typeof readyChannels === "object" ? readyChannels : {}) };
    const capabilities = { voice: !offline && Boolean(identity.telephony_credentials_id) && (preference ? preference.endpoint_id === voiceEndpoint?.id && endpointReady : voiceReady === true) };
    for (const channel of NATIVE_LIFECYCLE_CHANNELS) {
      capabilities[channel] = !offline && readyFlags[channel] === true && textRole
        && policies.find(policy => policy.channel === channel)?.enabled === true
        && (channel !== 'video' || !preference || preference.endpoint_id === voiceEndpoint?.id);
    }
    if (voiceEndpoint) await tx.query('UPDATE cc_voice_endpoints SET video_ready=$2 WHERE id=$1',
      [voiceEndpoint.id,!offline && readyFlags.video === true && textRole && policies.find(policy=>policy.channel==='video')?.enabled === true]);
    const sessionState = offline ? "offline" : Object.values(capabilities).some(Boolean) ? "online" : "degraded";
    const updated = await tx.query(
      `INSERT INTO acd_agent_sessions
         (id, agent_id, node_id, device_id, capabilities, state, heartbeat_at, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6,
               now(), now() + make_interval(secs=>$7))
       ON CONFLICT (id) DO UPDATE
         SET node_id = EXCLUDED.node_id,
             device_id = EXCLUDED.device_id,
             capabilities = EXCLUDED.capabilities,
             state = EXCLUDED.state,
             heartbeat_at = now(),
             expires_at = EXCLUDED.expires_at
       WHERE acd_agent_sessions.agent_id = EXCLUDED.agent_id
       RETURNING id`,
      [
        sessionId,
        agentId,
        node,
        String(deviceId || "browser").slice(0, 100),
        JSON.stringify(capabilities),
        sessionState,
        leaseSeconds,
      ],
    );
    if (!updated.rowCount) {
      throw Object.assign(new Error("Session belongs to another agent"), { status: 403 });
    }
    const ready = (
      await tx.query(
        `SELECT 1 FROM acd_agent_sessions
          WHERE agent_id = $1 AND state = 'online' AND expires_at > now()
            AND ${ANY_CAPABILITY("capabilities")} LIMIT 1`,
        [agentId],
      )
    ).rowCount > 0;
    const state = (
      await tx.query("SELECT presence FROM acd_agent_state WHERE agent_id = $1", [agentId])
    ).rows[0];
    const presence = ready ? "online" : "offline";
    if (state.presence !== presence) {
      await setAgentPresence(tx, agentId, presence, {
        actor: "session",
        reason: offline ? "device_offline" : "device_presence",
      });
    }
    await appendEvent(tx, {
      agentId,
      type: "agent_session_changed",
      payload: {
        session_id: sessionId,
        session_state: sessionState,
        capabilities,
      },
      actor: "session",
    });
    const sessions = (await tx.query(`SELECT capabilities FROM acd_agent_sessions
      WHERE agent_id=$1 AND state='online' AND expires_at>now()`, [agentId])).rows;
    const available = {};
    for (const channel of ["voice", ...NATIVE_LIFECYCLE_CHANNELS]) {
      available[channel] = sessions.some(row => row.capabilities?.[channel] === true);
    }
    await tx.query("COMMIT");
    return { sessionId, voiceReady: available.voice, chatReady: Boolean(available.chat), emailReady: Boolean(available.email), ready: available, expiresInSeconds: leaseSeconds };
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}

export async function expireAgentSessions(pool) {
  await pool.query(
    "UPDATE acd_agent_sessions SET state = 'offline' WHERE expires_at <= now() AND state <> 'offline'",
  );
  const agents = (
    await pool.query(
      `SELECT agent_id FROM acd_agent_state a
        WHERE presence = 'online'
          AND NOT EXISTS (
            SELECT 1 FROM acd_agent_sessions s
             WHERE s.agent_id = a.agent_id AND s.state = 'online'
               AND s.expires_at > now() AND ${ANY_CAPABILITY("s.capabilities")}
          )`,
    )
  ).rows;
  for (const { agent_id: agentId } of agents) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const state = (
        await tx.query("SELECT presence FROM acd_agent_state WHERE agent_id = $1 FOR UPDATE", [agentId])
      ).rows[0];
      const live = await tx.query(
        `SELECT 1 FROM acd_agent_sessions
          WHERE agent_id = $1 AND state = 'online' AND expires_at > now()
            AND ${ANY_CAPABILITY("capabilities")} LIMIT 1`,
        [agentId],
      );
      if (live.rowCount || state?.presence !== "online") {
        await tx.query("COMMIT");
        continue;
      }
      await setAgentPresence(tx, agentId, "offline", {
        actor: "session",
        reason: "session_expired",
      });
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }
  return agents.length;
}
