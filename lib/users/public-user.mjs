// Explicit allowlist: newly added authentication columns never enter API DTOs.
export const PUBLIC_USER_FIELDS = [
  'id', 'username', 'first_name', 'last_name', 'nick', 'language', 'theme',
  'mobile', 'sms_number', 'voice_number', 'roles', 'verified', 'active',
  'experimental_features', 'auth_strategy', 'profile_picture_uri', 'skills',
  'agent_groups', 'status', 'created_at', 'updated_at',
  'invite_status', 'invite_sent_at', 'invite_accepted_at', 'invite_token_expires',
];
export function publicUser(row) {
  if (!row) return null;
  return Object.fromEntries(PUBLIC_USER_FIELDS.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]));
}
