import { randomUUID } from "node:crypto";
import { channelDefinition, RELEASED_CHANNELS } from "./channel-registry.mjs";
export const DEFAULT_SLA = Object.freeze({
  voice: {
    enabled: true,
    thresholdSeconds: 20,
    targetPercentage: 80,
    warningPercentage: 80,
    clock: "24x7",
  },
});
export function validateSlaPolicy(raw, channel) {
  const definition = channelDefinition(channel);
  if (!definition.released || !definition.serviceEvent)
    throw Object.assign(new Error("SLA is unavailable for this channel"), {
      status: 400,
    });
  if (
    !raw ||
    typeof raw.enabled !== "boolean" ||
    raw.clock !== "24x7" ||
    !Number.isInteger(raw.thresholdSeconds) ||
    raw.thresholdSeconds < 1 ||
    raw.thresholdSeconds > 31 * 86400 ||
    !Number.isFinite(raw.targetPercentage) ||
    raw.targetPercentage <= 0 ||
    raw.targetPercentage > 100 ||
    !Number.isFinite(raw.warningPercentage) ||
    raw.warningPercentage <= 0 ||
    raw.warningPercentage >= 100
  )
    throw Object.assign(
      new Error(
        "Use a 24×7 clock, a positive threshold up to 31 days, a target in (0,100], and a warning in (0,100).",
      ),
      { status: 400 },
    );
  return {
    enabled: raw.enabled,
    thresholdSeconds: raw.thresholdSeconds,
    targetPercentage: raw.targetPercentage,
    warningPercentage: raw.warningPercentage,
    clock: "24x7",
    serviceEvent: definition.serviceEvent,
    scope: definition.slaScope,
  };
}
export function effectiveSlaPolicy(channel, global = {}, queue = null) {
  const definition = channelDefinition(channel),
    overrides = queue?.sla_policies || {};
  let selected = overrides[channel],
    source = "global",
    policy;
  // Preserve pre-existing queue voice targets as explicit overrides.
  if (
    selected == null &&
    definition.serviceEvent === "human_answer" &&
    queue?.sla_answer_threshold_seconds != null
  )
    selected = {
      mode: "override",
      policy: {
        ...DEFAULT_SLA.voice,
        thresholdSeconds: Number(queue.sla_answer_threshold_seconds),
        targetPercentage: Number(queue.sla_target_percentage ?? 80),
      },
    };
  if (selected?.mode === "disabled")
    return {
      status: "disabled",
      channel,
      serviceEvent: definition.serviceEvent,
      scope: definition.slaScope,
      source: "queue",
      revision: queue.sla_revision || 0,
    };
  if (selected?.mode === "override") {
    policy = selected.policy;
    source = "queue";
  } else policy = global.policies?.[channel] ?? DEFAULT_SLA[channel];
  if (!policy)
    return {
      status: "not_configured",
      channel,
      serviceEvent: definition.serviceEvent,
      scope: definition.slaScope,
      source,
      revision: global.revision || 0,
    };
  return {
    ...policy,
    channel,
    source,
    revision:
      source === "queue" ? queue.sla_revision || 0 : global.revision || 0,
    serviceEvent: definition.serviceEvent,
    scope: definition.slaScope,
    status: policy.enabled ? "configured" : "disabled",
  };
}
export function evaluateSla(measurement, now = Date.now()) {
  if (!measurement) return { state: "unavailable", atRisk: false };
  const policy = measurement.policy;
  if (measurement.excluded_reason) return { state: "excluded", atRisk: false };
  if (policy.status !== "configured")
    return { state: policy.status, atRisk: false };
  const deadline = Date.parse(measurement.deadline_at),
    served = Date.parse(measurement.served_at),
    terminal = Date.parse(measurement.ended_at);
  if (Number.isFinite(served))
    return { state: served <= deadline ? "met" : "breached", atRisk: false };
  const stop = Number.isFinite(terminal) ? terminal : Number(now);
  if (stop >= deadline) return { state: "breached", atRisk: false };
  if (Number.isFinite(terminal)) return { state: "unserved", atRisk: false };
  return {
    state: "pending",
    atRisk:
      stop >=
      Date.parse(measurement.started_at) +
        policy.thresholdSeconds * policy.warningPercentage * 10,
  };
}
export async function loadGlobalSla(db) {
  const exists = (
    await db.query(
      "SELECT to_regclass('public.app_settings') AS settings_table",
    )
  ).rows[0]?.settings_table;
  if (!exists) return { revision: 0, policies: DEFAULT_SLA };
  return (
    (
      await db.query(
        "SELECT cc_settings->'sla' AS sla FROM app_settings WHERE id='default'",
      )
    ).rows[0]?.sla || { revision: 0, policies: DEFAULT_SLA }
  );
}
export async function startSlaMeasurement(db, work, segment = null) {
  const definition = channelDefinition(work.channel);
  if (!definition.serviceEvent || !definition.released) return;
  if (definition.slaScope === "queue_visit" && segment?.kind !== "queue_wait")
    return;
  const queueId = segment?.queue_id || work.queue_id;
  const queue = queueId
    ? (
        await db.query(
          "SELECT to_jsonb(q) AS config FROM cc_queues q WHERE id=$1",
          [queueId],
        )
      ).rows[0]?.config
    : null;
  const policy = effectiveSlaPolicy(
    work.channel,
    await loadGlobalSla(db),
    queue,
  );
  const start =
    definition.slaScope === "queue_visit"
      ? segment.started_at
      : work.created_at;
  await db.query(
    `INSERT INTO acd_sla_measurements(id,work_item_id,segment_id,scope_key,channel,queue_id,policy,started_at,deadline_at,excluded_reason)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,CASE WHEN $9::int IS NOT NULL THEN $8::timestamptz+make_interval(secs=>$9) END,$10)
    ON CONFLICT(work_item_id,scope_key) DO NOTHING`,
    [
      randomUUID(),
      work.id,
      definition.slaScope === "queue_visit" ? segment.id : null,
      definition.slaScope === "queue_visit" ? segment.id : "interaction",
      work.channel,
      queueId,
      JSON.stringify(policy),
      start,
      policy.status === "configured" ? policy.thresholdSeconds : null,
      work.direction !== "inbound" ? "Non-inbound interaction" : null,
    ],
  );
}
// Provider adapters publish normalized durable evidence here. An observed late
// reply cannot reset a deadline; earlier evidence can correct its service time.
export async function recordSlaService(
  db,
  {
    workItemId,
    serviceEvent,
    occurredAt,
    evidenceId,
    agentId = null,
    segmentId = null,
  },
) {
  await db.query(
    `UPDATE acd_sla_measurements SET served_at=$3,service_evidence_id=$4,service_agent_id=$5
    WHERE work_item_id=$1 AND policy->>'serviceEvent'=$2 AND ($6::uuid IS NULL OR segment_id=$6)
      AND $3::timestamptz>=started_at AND (served_at IS NULL OR served_at>$3::timestamptz)`,
    [workItemId, serviceEvent, occurredAt, evidenceId, agentId, segmentId],
  );
}
export async function saveSlaPolicies(
  pool,
  { queueId = null, revision, policies, actor },
) {
  if (
    !Number.isInteger(revision) ||
    revision < 0 ||
    !policies ||
    typeof policies !== "object" ||
    Array.isArray(policies)
  )
    throw Object.assign(new Error("Policies and revision are required"), {
      status: 400,
    });
  const parsed = {};
  for (const [channel, value] of Object.entries(policies)) {
    if (!RELEASED_CHANNELS.includes(channel))
      throw Object.assign(new Error("Unknown or unreleased channel"), {
        status: 400,
      });
    if (queueId) {
      if (!["inherit", "override", "disabled"].includes(value?.mode))
        throw Object.assign(new Error("Invalid inheritance mode"), {
          status: 400,
        });
      parsed[channel] = {
        mode: value.mode,
        ...(value.mode === "override"
          ? { policy: validateSlaPolicy(value.policy, channel) }
          : {}),
      };
    } else parsed[channel] = validateSlaPolicy(value, channel);
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(741901, 12)");
    let current, saved;
    if (queueId) {
      current = (
        await db.query(
          "SELECT sla_policies,sla_revision FROM cc_queues WHERE id=$1 FOR UPDATE",
          [queueId],
        )
      ).rows[0];
      if (!current)
        throw Object.assign(new Error("Queue not found"), { status: 404 });
      if (Number(current.sla_revision) !== revision)
        throw Object.assign(
          new Error("SLA settings changed. Reload before saving."),
          { status: 409 },
        );
      saved = {
        revision: revision + 1,
        policies: { ...current.sla_policies, ...parsed },
      };
      await db.query(
        "UPDATE cc_queues SET sla_policies=$2::jsonb,sla_revision=$3 WHERE id=$1",
        [queueId, JSON.stringify(saved.policies), saved.revision],
      );
    } else {
      current = await loadGlobalSla(db);
      if (Number(current.revision) !== revision)
        throw Object.assign(
          new Error("SLA settings changed. Reload before saving."),
          { status: 409 },
        );
      saved = {
        revision: revision + 1,
        policies: { ...current.policies, ...parsed },
      };
      await db.query(
        `INSERT INTO app_settings(id,cc_settings,updated_by,updated_at) VALUES('default',jsonb_build_object('sla',$1::jsonb),$2,now())
        ON CONFLICT(id) DO UPDATE SET cc_settings=COALESCE(app_settings.cc_settings,'{}')||jsonb_build_object('sla',$1::jsonb),updated_by=$2,updated_at=now()`,
        [JSON.stringify(saved), actor],
      );
    }
    await db.query(
      "INSERT INTO cc_sla_policy_audit(id,queue_id,revision,policies,actor) VALUES($1,$2,$3,$4::jsonb,$5)",
      [
        randomUUID(),
        queueId,
        saved.revision,
        JSON.stringify(saved.policies),
        actor,
      ],
    );
    await db.query("COMMIT");
    return saved;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
