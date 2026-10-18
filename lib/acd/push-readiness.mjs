// A mobile registration outlives the signaling socket, but never its login or token.
export function mobileVoicePushTokenSql(device = 'd') {
  return `(CASE WHEN ${device}.kind='android' THEN NULLIF(${device}.fcm_token,'') ELSE NULLIF(${device}.voip_token,'') END)`;
}

export function mobileAlertTokenSql(device = 'd') {
  return `(CASE WHEN ${device}.kind='android' THEN NULLIF(${device}.fcm_token,'') ELSE NULLIF(${device}.alert_token,'') END)`;
}

export function validPushRegistrationSql(endpoint = 'e') {
  return `(${endpoint}.kind IN ('ios','android') AND ${endpoint}.revoked_at IS NULL AND EXISTS (
    SELECT 1 FROM cc_mobile_devices d JOIN users push_user ON push_user.id=d.user_id
    WHERE d.device_id=${endpoint}.device_id AND d.user_id=${endpoint}.agent_id
      AND d.auth_session_id=${endpoint}.auth_session_id AND d.kind=${endpoint}.kind
      AND ${mobileVoicePushTokenSql()} IS NOT NULL AND md5(${mobileVoicePushTokenSql()})=${endpoint}.push_token_hash
      AND push_user.active=true
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(push_user.refresh_tokens,'[]'::jsonb)) login
        WHERE login->>'sessionId'=${endpoint}.auth_session_id
          AND (login->>'expiresAt' IS NULL OR (login->>'expiresAt')::timestamptz>now()))))`;
}

export function voiceReachableSql(endpoint = 'e') {
  return `(${endpoint}.revoked_at IS NULL AND ${endpoint}.expires_at>now() AND
    ((${endpoint}.ready AND ${endpoint}.socket_ready_until>now()) OR
      (${endpoint}.push_ready AND ${validPushRegistrationSql(endpoint)})))`;
}

// Legacy logins without an expiry get a bounded shift, not permanent readiness.
export function pushLeaseSeconds(expiresAt, now = Date.now()) {
  const deadline = expiresAt ? Date.parse(expiresAt) : now + 12 * 3600_000;
  return Number.isFinite(deadline) ? Math.max(0, Math.floor((deadline - now) / 1000)) : 0;
}

export function videoReachableSql(endpoint = 'e') {
  return `(${endpoint}.revoked_at IS NULL AND ${endpoint}.video_ready
    AND ${endpoint}.video_ready_until>now())`;
}
