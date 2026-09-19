import { OUTBOUND_DIAL_STATE_UPGRADE } from "../../lib/outbound-dialer/dial-state-schema.mjs";
import { OUTBOUND_MESSAGING_UPGRADE } from "../../lib/outbound-dialer/messaging/schema.mjs";
import { readFileSync } from 'node:fs';
// Use the application's actual outbound table DDL, not a mock SQL parser.
export async function ensureOutboundTestSchema(pool) {
  const source = readFileSync(new URL('../../lib/postgres-schema.mjs', import.meta.url), 'utf8');
  const names = ['outbound_contact_lists', 'outbound_campaigns', 'outbound_contact_records', 'outbound_campaign_agent_assignments',
    'outbound_dnc_lists', 'outbound_dnc_entries', 'outbound_contact_filters', 'outbound_time_sets', 'outbound_attempt_controls',
    'outbound_settings', 'outbound_campaign_runs', 'outbound_attempt_ledger', 'outbound_webhook_events', 'cc_wrapup_codes', 'outbound_disposition_code_mappings'];
  await pool.query(`DROP TABLE IF EXISTS ${names.join(', ')} CASCADE`);
  await pool.query(`CREATE TABLE IF NOT EXISTS form_definitions (id UUID PRIMARY KEY);`);
  for (const name of names) {
    const start = source.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
    if (start < 0) throw new Error(`Missing production schema: ${name}`);
    const end = source.indexOf(');', start) + 2;
    await pool.query(source.slice(start, end));
  }
  await pool.query(OUTBOUND_DIAL_STATE_UPGRADE);
  await pool.query(OUTBOUND_MESSAGING_UPGRADE);
  await pool.query(`
    ALTER TABLE outbound_campaigns ADD COLUMN IF NOT EXISTS attempt_control_id UUID;
    INSERT INTO outbound_settings (id, settings) VALUES ('default', '{"max_lines":20,"allowed_numbers":["+15550001111"]}');`);
}
