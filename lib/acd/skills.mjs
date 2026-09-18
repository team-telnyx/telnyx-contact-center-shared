// Skill requirements are immutable intake data. Relaxation is derived from the
// work's persisted enqueue time on every decision, including after a restart.
export function skillObject(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function requiredSkillsFor(explicit, queueRequirements) {
  const parsed = skillObject(explicit);
  if (parsed === null || Object.keys(parsed).length) return { value: explicit, source: 'flow' };
  const fallback = skillObject(queueRequirements);
  return { value: queueRequirements ?? {}, source: fallback === null || Object.keys(fallback).length ? 'queue' : 'none' };
}

export function normalizeSkills(value, catalog = null, { requirements = false } = {}) {
  const parsed = skillObject(value);
  const unknown = [], invalid = [], result = new Map(), aliases = new Map();
  if (parsed === null) return { skills: {}, unknown, invalid: ['invalid_skill_object'] };
  for (const entry of catalog || []) {
    if (entry.is_active !== true) continue;
    for (const key of [entry.id, entry.name]) {
      if (!key) continue;
      const ids = aliases.get(key) || new Set();
      ids.add(entry.id); aliases.set(key, ids);
    }
  }
  for (const [key, rawLevel] of Object.entries(parsed)) {
    const level = Number(rawLevel), ids = aliases.get(key);
    const known = catalog === null || ids?.size === 1;
    if (!known) unknown.push(key);
    if ((typeof rawLevel !== 'number' && typeof rawLevel !== 'string') || String(rawLevel).trim() === '' || !Number.isInteger(level) || level < 1 || level > 5) {
      invalid.push(key); continue;
    }
    if (!known && !requirements) continue;
    const canonical = catalog === null || !known ? key : [...ids][0];
    const previous = result.get(canonical);
    // A duplicate name/ID must never weaken a requirement or inflate an agent.
    result.set(canonical, previous === undefined ? level : requirements ? Math.max(previous, level) : Math.min(previous, level));
  }
  return { skills: Object.fromEntries([...result].sort(([a], [b]) => a.localeCompare(b))), unknown: unknown.sort(), invalid: invalid.sort() };
}

export function skillRequirements(workItem, { queue = {}, catalog = null, now = Date.now() } = {}) {
  const snapshot = workItem.attributes?.routing_requirements;
  const selected = snapshot ? { value: workItem.required_skills, source: snapshot.source } : requiredSkillsFor(workItem.required_skills, queue.skill_requirements);
  const normalized = normalizeSkills(selected.value, catalog, { requirements: true });
  const unknown = [...new Set([...normalized.unknown, ...(snapshot?.unknown || [])])].sort();
  const invalid = [...new Set([...normalized.invalid, ...(snapshot?.invalid || [])])].sort();
  const enqueued = workItem.enqueued_at ? new Date(workItem.enqueued_at).getTime() : NaN;
  const clock = new Date(now).getTime(), waitMs = Number.isFinite(enqueued) ? Math.max(0, clock - enqueued) : 0;
  const threshold = Number(queue.skill_relaxation_after_seconds ?? 60);
  const thresholdSeconds = Number.isFinite(threshold) && threshold >= 0 ? threshold : 60;
  const enabled = queue.skill_relaxation_enabled === true;
  const strategy = queue.skill_relaxation_strategy === 'fallback' ? 'fallback' : 'progressive';
  const due = enabled && Number.isFinite(enqueued) && waitMs >= thresholdSeconds * 1000;
  const steps = due && strategy === 'progressive' ? Math.floor((waitMs - thresholdSeconds * 1000) / 30000) : 0;
  const effective = Object.fromEntries(Object.entries(normalized.skills).map(([id, level]) => [id,
    !due ? level : strategy === 'fallback' ? Math.min(level, 3) : Math.max(1, level - steps),
  ]));
  return { source: selected.source, original: normalized.skills, effective, unknown, invalid,
    relaxation: { enabled, strategy, threshold_seconds: thresholdSeconds, wait_ms: waitMs, steps, due, enqueued_at: workItem.enqueued_at ?? null } };
}

export function assessSkills(candidates, workItem, context = {}) {
  const requirements = skillRequirements(workItem, context);
  const assessments = candidates.map(candidate => {
    const normalized = normalizeSkills(candidate.skills, context.catalog ?? null);
    const missing = Object.entries(requirements.effective).filter(([id, level]) => (normalized.skills[id] || 0) < level)
      .map(([id, required]) => ({ id, required, actual: normalized.skills[id] || 0 }));
    const reason = requirements.unknown.length ? 'unknown_required_skill' : requirements.invalid.length ? 'invalid_required_skill' : missing.length ? 'skills_below_requirement' : null;
    const score = Object.keys(requirements.effective).reduce((sum, id) => sum + Math.min(normalized.skills[id] || 0, 5), 0);
    return { candidate, agent_id: candidate.agent_id, skills: normalized.skills, missing, reason, eligible: reason === null, score };
  });
  return { requirements, assessments };
}
