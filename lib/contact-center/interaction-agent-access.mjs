/**
 * Ownership check for an interaction's wrap-up / post-call endpoints.
 *
 * An interaction records its handling agent as `agent_username`. Different code
 * paths derive the current agent's username from different sources: the call
 * answer/routing path stores the session user's `.username`, while the wrap-up
 * endpoints re-query `users.username` by `user.id`. When those two sources
 * disagree for the same person (a renamed username row, an email-fallback login,
 * or session/id skew), a strict single-source check wrongly reports the call as
 * belonging to a "different agent" and freezes wrap-up.
 *
 * This helper accepts a match against ANY known username for the current user,
 * which removes that false rejection while still blocking a genuinely different
 * agent (who matches none of the candidates).
 *
 * Pure (no I/O) so it can be unit-tested directly; the route supplies the
 * candidate usernames it has resolved.
 *
 * @param {{agent_username?: string|null}|null|undefined} interaction
 * @param {Array<string|null|undefined>|string|null|undefined} usernames - candidate usernames for the current user
 * @returns {boolean} true if the current user may act on the interaction
 */
export function interactionAgentMatches(interaction, usernames = []) {
  // An interaction with no assigned agent is open to any authenticated agent.
  if (!interaction?.agent_username) return true;

  const list = Array.isArray(usernames) ? usernames : [usernames];
  const candidates = list.filter((u) => typeof u === "string" && u.length > 0);

  // If we could not derive any identity for the current user, don't block —
  // matches the previous behavior of skipping the check when username was falsy.
  if (candidates.length === 0) return true;

  return candidates.includes(interaction.agent_username);
}
