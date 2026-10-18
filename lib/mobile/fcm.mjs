import { GoogleAuth } from 'google-auth-library';
import { mobileAlertPayload } from './alert-payload.mjs';

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export function fcmConfiguration(env = process.env) {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) return null;
  // JSON parser errors can contain the private key. Never propagate their text.
  try {
    const credentials = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON);
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(env.FCM_PROJECT_ID || '') ||
        credentials.type !== 'service_account' ||
        typeof credentials.client_email !== 'string' || !credentials.client_email ||
        typeof credentials.private_key !== 'string' || !credentials.private_key) throw new Error();
    return {
      projectId: env.FCM_PROJECT_ID,
      credentials: {
        type: 'service_account',
        client_email: credentials.client_email,
        private_key: credentials.private_key.replace(/\\n/g, '\n'),
        project_id: env.FCM_PROJECT_ID,
      },
    };
  } catch {
    throw new Error('Invalid FCM configuration');
  }
}

export function fcmAlertMessage(notification, now = Date.now()) {
  const payload = mobileAlertPayload(notification);
  const remaining = Math.floor((new Date(notification.expires_at).getTime() - now) / 1000);
  return { message: {
    token: notification.fcm_token,
    android: { priority: 'HIGH', ttl: `${Math.max(0, Math.min(2419200, Number.isFinite(remaining) ? remaining : 300))}s` },
    data: {
      title: String(payload.aps.alert.title),
      body: String(payload.aps.alert.body),
      ...(notification.work_item_id ? { interactionId: String(notification.work_item_id) } : {}),
    },
  } };
}

function retryAfterSeconds(value, now) {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, Math.min(86400, seconds)) : 0;
}

export function fcmFailure(status, body, retryAfter = null, now = Date.now()) {
  const error = body?.error || {};
  const details = Array.isArray(error.details) ? error.details : [];
  const code = details.find(item => item?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
  const tokenField = details.some(item => item?.['@type'] === 'type.googleapis.com/google.rpc.BadRequest' &&
    item.fieldViolations?.some(field => field.field === 'message.token'));
  const invalidToken = (status === 404 && code === 'UNREGISTERED') ||
    (status === 400 && (tokenField || (code === 'INVALID_ARGUMENT' && /registration token|message\.token/i.test(error.message || ''))));
  const retryable = status === 429 || status >= 500;
  return {
    status,
    invalidToken,
    retryable,
    reason: invalidToken ? 'FcmInvalidToken' : status === 429 ? 'FcmRateLimited' : status >= 500 ? 'FcmUnavailable' : 'FcmRejected',
    retryAfterSeconds: Math.max(status === 429 ? 60 : 0, retryAfterSeconds(retryAfter, now)),
  };
}

/** One auth client per worker; GoogleAuth caches and refreshes OAuth credentials. */
export function createFcmSender(config, {
  fetchImpl = globalThis.fetch,
  authFactory = options => new GoogleAuth(options),
  now = Date.now,
} = {}) {
  const auth = config ? authFactory({
    credentials: config.credentials,
    scopes: [FCM_SCOPE],
    clientOptions: { eagerRefreshThresholdMillis: 60000, transporterOptions: { timeout: 5000 } },
  }) : null;
  return async notification => {
    if (!config) return { status: 0, skipped: true, reason: 'FcmNotConfigured' };
    let token;
    try {
      token = await auth.getAccessToken();
      if (!token) throw new Error();
    } catch {
      return { status: 503, retryable: true, reason: 'FcmAuthUnavailable' };
    }
    // OAuth renewal can outlast a short offer. TTL zero means immediate
    // delivery in FCM, so it must not turn an expired offer into a fresh alert.
    if (new Date(notification.expires_at).getTime() <= now()) {
      return { status: 410, reason: 'ExpiredOffer' };
    }
    try {
      const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fcmAlertMessage(notification, now())),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return { status: 200 };
      const body = await response.json().catch(() => null);
      // Do not return provider text, HTTP request objects or OAuth errors: all
      // can echo registration tokens/private keys into worker logs or last_error.
      return fcmFailure(response.status, body, response.headers.get('retry-after'), now());
    } catch {
      return { status: 503, retryable: true, reason: 'FcmTransportError' };
    }
  };
}
