import { createHash } from 'node:crypto';
// Server-derived: a client cannot select or clear another session's composer.
export function messagingDraftScope(user) {
  return user?.authSessionId
    ? createHash('sha256').update(String(user.authSessionId)).digest('hex') : 'legacy';
}
