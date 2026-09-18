import { domainToASCII } from 'node:url';
import { emailConfig, emailError, emailId } from './provider.mjs';
import { resolveWebhookBaseUrl } from '../webhook-base-url.mjs';

export function normalizeEmailDomain(value) {
  const input = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!input || /[\s/@:?#\\]/.test(input)) throw emailError('Enter a domain name, such as mail.example.com');
  const domain = domainToASCII(input);
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || !/[a-z]/.test(labels.at(-1)) ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw emailError('Enter a valid domain name, such as mail.example.com');
  }
  return domain;
}

export async function configuredEmailDomains(db) {
  const settings = (await db.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0]?.cc_settings;
  const mailboxes = (await db.query('SELECT address FROM cc_email_mailboxes')).rows;
  const names = [emailConfig().domain, ...(Array.isArray(settings?.email_domains) ? settings.email_domains : []),
    ...mailboxes.map(mailbox => mailbox.address?.split('@')[1])];
  return [...new Set(names.filter(Boolean).map(normalizeEmailDomain))];
}

export async function rememberEmailDomain(db, domain) {
  // Merge inside PostgreSQL so concurrent registrations do not overwrite each other
  // or unrelated Contact Center settings.
  await db.query(`INSERT INTO app_settings(id,cc_settings)
    VALUES('default',jsonb_build_object('email_domains',jsonb_build_array($1::text)))
    ON CONFLICT(id) DO UPDATE SET cc_settings=COALESCE(app_settings.cc_settings,'{}'::jsonb)||
      jsonb_build_object('email_domains',(SELECT jsonb_agg(DISTINCT name) FROM jsonb_array_elements(
        COALESCE(app_settings.cc_settings->'email_domains','[]'::jsonb)||jsonb_build_array($1::text)) AS names(name)))`, [domain]);
}

export async function listEmailDomains(request) {
  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const result = await request(`/email_domains?page[size]=100&page[number]=${page}`);
    rows.push(...(result.data || []));
    if (page >= Number(result.meta?.total_pages || 1)) return rows;
  }
  throw emailError('Too many email domains to load. Narrow the connected account scope.', 502);
}

const WEBHOOK_EVENTS = ['email.received','email.queued','email.sent','email.delivered','email.deferred','email.bounced','email.failed','email.sandbox'];

export async function ensureEmailWebhook(domainId, request) {
  if (!(process.env.TELNYX_WEBHOOK_PUBLIC_KEY || process.env.TELNYX_WEBHOOK_SECRET)) {
    throw emailError('Configure the Telnyx webhook public key on the server, then verify the domain again.', 503);
  }
  const url = new URL(`${resolveWebhookBaseUrl()}/api/webhooks/telnyx/email`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw emailError('Configure a public HTTPS application base URL on the server, then verify the domain again.', 503);
  }
  const root = `/email_domains/${emailId(domainId)}/webhooks`;
  const hooks=[];
  for(let page=1;page<=100;page++){
    const result=await request(`${root}?page[size]=100&page[number]=${page}`);
    if(!Array.isArray(result.data))throw emailError('Invalid email webhook response',502);
    hooks.push(...result.data);
    if(page>=Number(result.meta?.total_pages||1))break;
    if(page===100)throw emailError('Too many email webhook pages to load',502);
  }
  const existing = hooks.find(hook => hook.url === url.href);
  if (existing && WEBHOOK_EVENTS.every(event => existing.events?.includes(event))) return;
  await request(`${root}${existing ? `/${emailId(existing.id)}` : ''}`, {
    method: existing ? 'PATCH' : 'POST',
    body: {url: url.href, events: [...new Set([...(existing?.events || []), ...WEBHOOK_EVENTS])]},
  });
}
