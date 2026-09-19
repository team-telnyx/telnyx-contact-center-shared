// Authorization shared by Core transfer, consult and direct-call intents.
// The latest Core agent segment is the assignment owner; caller-supplied
// interaction metadata is never treated as proof.

function privileged(user) {
  return (user?.roles || []).some((role) =>
    ["admin", "owner", "supervisor"].includes(String(role).toLowerCase()),
  );
}

export function authorizeInteractionControl(interaction, user) {
  if (!user) return { ok: false, status: 401, error: "Unauthorized" };
  if (!interaction) {
    return { ok: false, status: 404, error: "Interaction not found" };
  }
  if (interaction.terminal_at || interaction.completed_at || interaction.abandoned_at) {
    return { ok: false, status: 409, error: "Interaction has ended" };
  }
  const ownsById = user.id && String(interaction.agent_id) === String(user.id);
  const ownsByUsername =
    user.username && interaction.agent_username === user.username;
  const owns = Boolean(ownsById || ownsByUsername);
  if (!owns && !privileged(user)) {
    return {
      ok: false,
      status: 403,
      error: "Interaction ownership could not be verified",
    };
  }
  return { ok: true, privileged: privileged(user) && !owns };
}

export async function authorizePersistedInteractionControl(
  pool,
  interaction,
  user,
  { operation = null } = {},
) {
  if (!user) return { ok: false, status: 401, error: "Unauthorized" };
  if (!interaction) {
    return { ok: false, status: 404, error: "Interaction not found" };
  }
  if (!pool) {
    return { ok: false, status: 503, error: "Ownership database unavailable" };
  }

  const workItemId = interaction.work_item_id || interaction.id;
  const result = await pool.query(
    `SELECT w.id, w.terminal_at, s.agent_id, u.username AS agent_username,
            customer.provider_call_id AS call_control_id
       FROM acd_work_items w
       LEFT JOIN LATERAL (
         SELECT agent_id
           FROM acd_segments
          WHERE work_item_id = w.id AND kind = 'agent'
          ORDER BY (ended_at IS NULL) DESC, seq DESC
          LIMIT 1
       ) s ON true
       LEFT JOIN users u ON u.id = s.agent_id
       LEFT JOIN LATERAL (
         SELECT provider_call_id
           FROM acd_legs
          WHERE work_item_id = w.id AND role = 'customer'
          ORDER BY created_at
          LIMIT 1
       ) customer ON true
      WHERE w.id::text = $1
      LIMIT 1`,
    [String(workItemId)],
  );
  const persisted = result.rows[0];
  const decision = authorizeInteractionControl(persisted, user);
  if (decision.ok && decision.privileged) {
    const { appendEvent } = await import("../acd/events.mjs");
    try {
      await appendEvent(pool, {
        workItemId: persisted.id,
        agentId: persisted.agent_id,
        type: "privileged_interaction_control",
        actor: `supervisor:${user.username || user.id || "unknown"}`,
        payload: {
          operation: operation || "interaction_control",
          owner_username: persisted.agent_username || null,
          call_control_id: persisted.call_control_id || null,
          roles: (user.roles || []).map((role) => String(role).toLowerCase()),
        },
      });
    } catch (error) {
      console.error("[ACD] privileged interaction control audit failed:", {
        interactionId: persisted.id,
        actor: user.username || user.id || "unknown",
        operation: operation || "interaction_control",
        error: String(error?.message || error),
      });
    }
  }
  return decision;
}
