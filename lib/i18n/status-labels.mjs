// Canonical values match the built-in database seed. Localize at display time,
// never in API payloads, routing comparisons, stored history or custom names.
export const DEFAULT_AGENT_STATUSES = Object.freeze([
  { name: 'Available', description: 'Agent is available to take calls' },
  { name: 'Busy', description: 'Agent is busy handling calls' },
  { name: 'Away', description: 'Agent is away from desk' },
  { name: 'Offline', description: 'Agent is offline' },
  { name: 'Break', description: 'Agent is on break' },
  { name: 'Wrapup', description: 'Agent is finishing wrapup' },
  { name: 'Lunch', description: 'Agent is on lunch break' },
  { name: 'Vacation', description: 'Agent is on vacation' },
  { name: 'Sick', description: 'Agent is out sick' },
  { name: 'Training', description: 'Agent is in training' },
  { name: 'Agent Not Answering', description: 'Agent did not answer call within timeout period' },
  { name: 'On Outbound Call', description: 'Agent is handling an outbound call' },
]);
const SYSTEM_STATUSES = new Set([...DEFAULT_AGENT_STATUSES.map(status => status.name), 'Unknown']);
const descriptions = new Set(DEFAULT_AGENT_STATUSES.map(status => status.description));
export function statusLabel(t, value) {
  return SYSTEM_STATUSES.has(value) ? t(value) : value;
}
export function statusDescription(t, value) {
  return descriptions.has(value) ? t(value) : value;
}
