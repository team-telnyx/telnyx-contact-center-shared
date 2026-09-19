// ACD ranking policies (the internal documentation §5.3). Pure functions: no I/O.
// Candidates arrive with: agent_id, capacity, live_weight, queue_priority,
// last_released_at (proxy for longest-available), skills (jsonb from users).

import { assessSkills } from '../skills.mjs';

function longestAvailableFirst(a, b) {
  const at = a.last_released_at ? new Date(a.last_released_at).getTime() : 0;
  const bt = b.last_released_at ? new Date(b.last_released_at).getTime() : 0;
  if (at !== bt) return at - bt; // older release ⇒ longer idle ⇒ first
  if (Number(a.live_weight) !== Number(b.live_weight)) {
    return Number(a.live_weight) - Number(b.live_weight);
  }
  return String(a.agent_id).localeCompare(String(b.agent_id)); // deterministic tie-break
}

export const fifoPolicy = {
  name: "fifo",
  rank(candidates) {
    return [...candidates].sort(longestAvailableFirst);
  },
};

export const priorityPolicy = {
  name: "priority",
  rank(candidates) {
    return [...candidates].sort((a, b) => {
      const priorityDiff = Number(b.queue_priority || 0) - Number(a.queue_priority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return longestAvailableFirst(a, b);
    });
  },
};

function parseSkills(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function skillMatch(agentSkills, requiredSkills) {
  const required = Object.entries(requiredSkills || {});
  if (required.length === 0) return { full: true, ratio: 1, score: 0 };
  const skills = parseSkills(agentSkills);
  let matched = 0;
  let score = 0;
  for (const [name, minProficiency] of required) {
    const proficiency = Number(skills?.[name] ?? 0);
    if (proficiency >= Number(minProficiency || 1)) {
      matched += 1;
      score += Math.min(proficiency, 5);
    }
  }
  return { full: matched === required.length, ratio: matched / required.length, score };
}

function evaluateSkills(candidates, workItem = {}, context = {}) {
  const assessment = assessSkills(candidates, workItem, context);
  const ranked = assessment.assessments.filter(a => a.eligible)
    .sort((a, b) => b.score - a.score || longestAvailableFirst(a.candidate, b.candidate))
    .map(a => a.candidate);
  return { ...assessment, ranked };
}

export const skillsPolicy = {
  name: 'skills',
  evaluate: evaluateSkills,
  rank(candidates, workItem = {}, context = {}) { return evaluateSkills(candidates, workItem, context).ranked; },
};

const POLICIES = Object.freeze({
  fifo: fifoPolicy,
  priority: priorityPolicy,
  skills: skillsPolicy,
});

// Legacy cc_queues.routing_strategy values → policy names.
const LEGACY_STRATEGY_MAP = Object.freeze({
  FIFO: "fifo",
  "Priority-based": "priority",
  "Skill-based": "skills",
});

export function resolvePolicy(routingStrategy) {
  const name = LEGACY_STRATEGY_MAP[routingStrategy] || routingStrategy || "fifo";
  return POLICIES[name] || fifoPolicy;
}
