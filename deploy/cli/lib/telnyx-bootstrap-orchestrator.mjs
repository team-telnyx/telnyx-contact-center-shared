// Orchestrator that drives the Telnyx bootstrap end-to-end. The wizard's
// Step 7 (and the standalone `./deploy/cc telnyx` command) call this; the
// individual upsert functions in telnyx-bootstrap.mjs are kept exported so
// tests and future repair modes can target a single resource.
//
// Key design points (matching the v2 IaC plan, Section 3):
//   - Idempotent at every step: every create is gated by a find-by-name (or
//     find-by-phone-number) lookup first, so re-running on an interrupted run
//     picks up exactly where it left off without duplicating anything.
//   - Number purchase is the one operation that costs money and is NOT free
//     to repeat: it's gated by an explicit user-side confirm step (the wizard
//     calls `pickPhoneNumber` which returns a `pendingConfirmation: true`
//     marker; the wizard renders the candidate + price and asks the user to
//     accept before calling `purchasePhoneNumber`). Bypass for `--yes-number`
//     in unattended mode.
//   - "created" vs "found" vs "updated" outcome is returned per resource so
//     the wizard's log output is precise.
//   - No AI Assistant objects are touched here (standing rule: one TeXML app
//     per assistant; the bootstrap only handles the deployment-level Voice
//     App + WebRTC SIP conn + owner credential + 1 number).

import {
  upsertVoiceApp,
  upsertOutboundVoiceProfile,
  upsertWebrtcCredentialConnection,
  searchPhoneNumbers,
  purchasePhoneNumber,
  assignPhoneNumberToVoiceApp,
  listOwnedPhoneNumbers,
  getAccountBalance,
  getWebhookPublicKey,
  upsertIntegrationSecret,
} from './telnyx-bootstrap.mjs';
import { ensureMediaFiles } from './telnyx-media.mjs';
import { randomHexSecret } from './envgen.mjs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The exact set of shipped audio assets the Default Call Flow template /
// seeded "Sales" queue reference by media_name — see
// lib/default-call-flow-template.mjs and
// lib/seeded-default-queue-template.mjs (main app tree) for where each name
// is actually consumed. Kept here (not derived from those files) for the
// same "deploy/cli is its own isolated dependency tree" reason
// SEEDED_DEFAULT_FLOW_ID below is duplicated rather than imported — this
// module has no reach into the main app's lib/ tree. The queue's hold-audio
// (queue_audio_media_name) is the only one actually wired into the shipped
// templates today; roa_haru/sweet-dreams ship alongside it as ready-to-use
// media library entries (visible immediately in Admin > Media Library) since
// they came from the same source account as spring_field and have no reason
// to be uploaded selectively.
const SHIPPED_MEDIA_FILES = [
  { name: 'spring_field', filePath: join(__dirname, '..', 'assets', 'media', 'spring_field.mp3') },
  { name: 'roa_haru', filePath: join(__dirname, '..', 'assets', 'media', 'roa_haru.mp3') },
  { name: 'sweet-dreams', filePath: join(__dirname, '..', 'assets', 'media', 'sweet-dreams.mp3') },
];

// Fixed identifier used for the AI webhook auth secret stored in Telnyx's
// Secrets Manager (referenced by TELNYX_AI_API_KEY_REF). Kept as a constant
// (not derived from deploymentName) because it's referenced by name from
// voice flow HTTP request nodes / AI Assistant webhook config — a stable,
// predictable identifier is more useful here than a per-deployment one.
const AI_API_KEY_IDENTIFIER = 'telnyx-ai-api-key';

// MUST match lib/seed-default-call-flow.mjs's SEEDED_DEFAULT_FLOW_ID exactly
// — deliberately duplicated (not imported) rather than reaching across into
// the main app's lib/ tree, since deploy/cli is its own isolated dependency
// tree (see deploy/cli/package.json's description). This is what lets the
// Default Call Flow's dedicated Telnyx voice app be created here, during
// Telnyx provisioning (webhook URL known up front, no chicken-and-egg with
// the not-yet-created DB row), while the DB-side seeding itself happens at
// app boot (lib/seed-default-call-flow.mjs) — see telnyx-bootstrap-orchestrator.test.mjs's
// cross-file constant-parity test, which fails loudly if these ever drift.
const SEEDED_DEFAULT_FLOW_ID = '00000000-cc00-4000-8000-000000000001';

export function nameForDeployment({ deploymentName, suffix }) {
  return `${deploymentName}-${suffix}`;
}

/**
 * Step A+B+C: create / find the three deployment-level Telnyx objects.
 * Returns the canonical resource IDs plus a list of human-readable log lines
 * for the wizard to print.
 */
export async function ensureCoreTelnyxObjects({
  fetchImpl,
  basePath,
  apiKey,
  deploymentName,
  baseUrl,
  log = () => {},
  // Called after each sub-resource is created/found so the caller (wizard)
  // can persist granular progress to .cc-state.json immediately — not just
  // after the whole function returns. This is what makes resume actually
  // skip completed sub-steps after a crash mid-bootstrap (e.g. the OVP +
  // voice app succeeded but the credential connection call 422'd): without
  // per-resource persistence, a crash here would lose all progress from this
  // function even though 2 of 4 Telnyx resources already exist.
  onSubStep = () => {},
}) {
  const voiceAppName = nameForDeployment({ deploymentName, suffix: 'voice-app' });
  const outboundName = nameForDeployment({ deploymentName, suffix: 'outbound' });
  const webrtcName = nameForDeployment({ deploymentName, suffix: 'webrtc' });
  const defaultFlowVoiceAppName = nameForDeployment({ deploymentName, suffix: 'default-flow' });

  const webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/voice/webhook`;
  // Known up front (fixed flow id — see SEEDED_DEFAULT_FLOW_ID's header
  // comment) even though the actual `voice_flows` DB row doesn't exist yet
  // at this point in the wizard — it gets written by
  // lib/seed-default-call-flow.mjs the first time the app container boots
  // with this env var set. Deriving the URL here (not after DB seeding)
  // is what makes this work identically for AWS/cloud targets, whose
  // Postgres is unreachable from the machine running this wizard.
  const defaultFlowWebhookUrl = `${baseUrl.replace(/\/$/, '')}/api/voice/webhook/incoming/${SEEDED_DEFAULT_FLOW_ID}`;

  // Outbound profile first — voice app + webrtc connection both reference it.
  const ovp = await upsertOutboundVoiceProfile({
    fetchImpl, basePath, apiKey, name: outboundName,
  });
  log(`  ${outcomeIcon(ovp.outcome)} Outbound voice profile  "${outboundName}"  id ${ovp.id}  ${ovp.outcome}`);
  onSubStep('outboundVoiceProfile', ovp);

  const voiceApp = await upsertVoiceApp({
    fetchImpl, basePath, apiKey, name: voiceAppName,
    webhookUrl, outboundVoiceProfileId: ovp.id,
  });
  log(`  ${outcomeIcon(voiceApp.outcome)} Voice API application  "${voiceAppName}"  id ${voiceApp.id}  ${voiceApp.outcome}`);
  log(`      webhook: ${webhookUrl}`);
  onSubStep('voiceApp', voiceApp);

  const webrtc = await upsertWebrtcCredentialConnection({
    fetchImpl, basePath, apiKey, name: webrtcName, outboundVoiceProfileId: ovp.id, webhookUrl,
  });
  log(`  ${outcomeIcon(webrtc.outcome)} WebRTC SIP connection  "${webrtcName}"  id ${webrtc.id}  ${webrtc.outcome}  (credential connection, webrtc enabled)`);
  onSubStep('sipConnection', webrtc);

  // Default Call Flow's own dedicated voice app (separate from the main
  // WebRTC-agent voice app above — standing "one TeXML app per thing" rule,
  // so inbound PSTN calls to the Default Call Flow never collide with WebRTC
  // agent registrations). sip_subdomain=flowId mirrors the app's own
  // lib/telnyx-voice-apps.js convention for user-created flows. Created here
  // (during Telnyx provisioning, which always runs on the operator's own
  // machine where Telnyx's public API is reachable) rather than by the app
  // at boot time, because creating it requires talking to the Telnyx API —
  // unlike the DB-side flow row, which lib/seed-default-call-flow.mjs writes
  // once the app is actually running (local docker OR any cloud target).
  const defaultFlowVoiceApp = await upsertVoiceApp({
    fetchImpl, basePath, apiKey, name: defaultFlowVoiceAppName,
    webhookUrl: defaultFlowWebhookUrl, outboundVoiceProfileId: ovp.id, sipSubdomain: SEEDED_DEFAULT_FLOW_ID,
  });
  log(`  ${outcomeIcon(defaultFlowVoiceApp.outcome)} Default Call Flow voice app  "${defaultFlowVoiceAppName}"  id ${defaultFlowVoiceApp.id}  ${defaultFlowVoiceApp.outcome}`);
  log(`      webhook: ${defaultFlowWebhookUrl}`);
  onSubStep('defaultFlowVoiceApp', defaultFlowVoiceApp);


  // NOTE: no owner telephony credential is created here anymore. Confirmed
  // against app/api/auth/[...nextauth]/route.js (both the Credentials
  // `authorize()` path and the JWT callback): on every login, if the
  // authenticated user's `users` row has no telephony_credentials_id, the
  // app itself calls createUserTelephonyCredentials() and persists the
  // result via PgDb.updateUserById() — this covers the owner exactly the
  // same as any other user, the very first time they log in. Pre-creating
  // one here was pure duplication: it left an extra, unused Telnyx
  // telephony_credentials resource sitting around for every deploy/redeploy
  // (each wizard re-run created a NEW one since there's no idempotent
  // find-by-name reuse across runs), and real E2E testing confirmed the
  // owner logs in and gets full WebRTC calling with zero extra wiring here.
  // See ensureCoreTelnyxObjects's return value below: ownerCredential and
  // the TELNYX_OWNER_TELEPHONY_* env vars are gone; seed-default-owner.mjs
  // no longer needs (or reads) them either.

  // Webhook signing public key — GET /v2/public_key returns the account's
  // stable Ed25519 public key (base64, 32 bytes). Safe to fetch + overwrite
  // .env on every run: it's a read-only account property, not something we
  // create, so there's no "found vs created" distinction and no resume risk.
  let webhookSecret = null;
  try {
    const pk = await getWebhookPublicKey({ fetchImpl, basePath, apiKey });
    webhookSecret = pk.publicKey;
    log(`  ✔ Webhook signing public key  fetched (org ${pk.organizationId || '?'})`);
    onSubStep('webhookPublicKey', pk);
  } catch (err) {
    log(`  ⚠ Could not fetch webhook signing public key: ${err.message}`);
  }

  // AI webhook auth (TELNYX_AI_API_KEY / TELNYX_AI_API_KEY_REF): generate a
  // random bearer token and register it in Telnyx's Secrets Manager under a
  // fixed identifier so voice flow HTTP nodes / AI Assistant webhooks can
  // reference it via {{#integration_secret}}telnyx-ai-api-key{{/integration_secret}}.
  //
  // IMPORTANT idempotency note: Telnyx's integration secrets have NO update
  // endpoint (list/create/delete only). If an identifier with this name
  // already exists (outcome 'found'), the token we just generated here is NOT
  // what's actually stored there — writing it to .env would silently break
  // AI webhook auth (the app would send a header value Telnyx never
  // registered). So we only write TELNYX_AI_API_KEY to .env when we actually
  // created the secret this run; on 'found' we leave whatever's already in
  // .env from the original run alone and just warn.
  const aiApiKeyToken = randomHexSecret(32);
  let aiApiKeyEnvUpdate = {};
  try {
    const secret = await upsertIntegrationSecret({
      fetchImpl, basePath, apiKey, identifier: AI_API_KEY_IDENTIFIER, token: aiApiKeyToken,
    });
    log(`  ${outcomeIcon(secret.outcome)} Integration secret       "${AI_API_KEY_IDENTIFIER}"  id ${secret.id}  ${secret.outcome}`);
    onSubStep('aiApiKeySecret', secret);
    if (secret.outcome === 'created') {
      aiApiKeyEnvUpdate = { TELNYX_AI_API_KEY: aiApiKeyToken, TELNYX_AI_API_KEY_REF: AI_API_KEY_IDENTIFIER };
    } else {
      log(`      ⚠ Secret "${AI_API_KEY_IDENTIFIER}" already exists in Telnyx — its value can't be read back, so TELNYX_AI_API_KEY in .env is left untouched (re-create the secret via the Telnyx portal if you need to rotate it).`);
      aiApiKeyEnvUpdate = { TELNYX_AI_API_KEY_REF: AI_API_KEY_IDENTIFIER };
    }
  } catch (err) {
    log(`  ⚠ Could not create/find AI webhook integration secret: ${err.message}`);
  }

  // Shipped media library assets (queue hold audio + ready-to-use library
  // entries) — see SHIPPED_MEDIA_FILES's header comment above for exactly
  // which files and why. Uploaded here (not from the app at boot, unlike
  // seed-default-queue.mjs's DB rows) because it requires Telnyx API
  // access, which this step always has (runs on the operator's own
  // machine) but a cloud target's app container may not (no reason to add
  // an outbound-Telnyx-API-access requirement to every deployment target
  // just for three static files). Best-effort per-file (see
  // ensureMediaFiles's docstring) — a single file's upload failing does
  // not abort the rest of Telnyx provisioning; the queue's hold-audio
  // reference would just silently have no matching media until re-run.
  const mediaResults = await ensureMediaFiles({
    fetchImpl, basePath, apiKey, files: SHIPPED_MEDIA_FILES, log,
  });
  onSubStep('mediaFiles', mediaResults);

  return {
    voiceApp,
    outboundVoiceProfile: ovp,
    sipConnection: webrtc,
    defaultFlowVoiceApp,
    mediaFiles: mediaResults,
    envUpdates: {
      TELNYX_CALL_CONTROL_ID: voiceApp.id,
      TELNYX_OUTBOUND_VOICE_PROFILE: ovp.id,
      TELNYX_SIP_CONNECTION_ID: webrtc.id,
      TELNYX_DEFAULT_FLOW_VOICE_APP_ID: defaultFlowVoiceApp.id,
      NEXT_PUBLIC_TELNYX_WEBRTC_REGION: 'auto',
      ...(webhookSecret ? { TELNYX_WEBHOOK_SECRET: webhookSecret } : {}),
      ...aiApiKeyEnvUpdate,
    },
  };
}

/**
 * Step D: pick a phone number. Returns the full list of candidates plus the
 * account balance so the wizard can:
 *   1. Show the user the current balance (so they know how much they're spending).
 *   2. Verify they can afford the cheapest candidate BEFORE searching.
 *   3. Let the user PICK which one to buy (via io.select) rather than blindly
 *      buying the top-1 (previous behaviour).
 *
 * The wizard is responsible for the actual confirm/select UX — this function
 * just gathers the data. For unattended mode the wizard passes
 * `pickedNumber: { id, phone_number }` straight through and skips this call.
 *
 * Throws a structured error (`code: 'INSUFFICIENT_BALANCE'`) when the account
 * can't afford the cheapest candidate, so the wizard can render a targeted
 * "go fund your Telnyx account" message instead of a confusing 422 later.
 */
export async function pickPhoneNumber({
  fetchImpl,
  basePath,
  apiKey,
  countryCode = 'US',
  locality,
  limit = 5,
  // When true, skip the balance check (used by `cc doctor` which doesn't need
  // to gate on funds). The wizard always passes false.
  skipBalanceCheck = false,
  log = () => {},
}) {
  // Fetch balance first so the wizard can show it alongside the candidate list.
  let balance = null;
  if (!skipBalanceCheck) {
    try {
      balance = await getAccountBalance({ fetchImpl, basePath, apiKey });
      log(`  💰 Account balance: $${balance.balance.toFixed(2)}  (available credit: $${balance.availableCredit.toFixed(2)})`);
    } catch (err) {
      // Don't hard-fail on balance fetch — the API may 403 on keys without
      // billing scope. Log a soft warning and let the wizard decide.
      log(`  ⚠ Could not fetch account balance: ${err.message}`);
    }
  }

  const results = await searchPhoneNumbers({ fetchImpl, basePath, apiKey, countryCode, locality, limit });
  if (!results.length) {
    return { candidates: [], balance, pendingConfirmation: false };
  }
  // Defensive sort by monthly cost ascending so the cheapest shows first.
  const sorted = [...results].sort((a, b) => parseFloat(a?.cost_information?.monthly_cost || '0') - parseFloat(b?.cost_information?.monthly_cost || '0'));
  // Only log the summary line here, not the per-number listing — the
  // interactive wizard (runWizard/runAwsWizardTail/runGcpWizardTail/
  // runAzureWizardTail) immediately follows this with an io.select() menu
  // built from these SAME `sorted` candidates, which already renders each
  // number + its monthly cost as a selectable row. Printing the full list
  // here too used to duplicate it on screen (plain-text dump, then the
  // identical interactive picker right below it) — see cc.mjs's own
  // unattended --non-interactive path for the one caller that has no
  // follow-up picker and therefore still needs this summary line to convey
  // *something* was found before it auto-picks the cheapest.
  log(`  ⠸ Found ${sorted.length} ${countryCode} number(s) — top ${sorted.length} listed by monthly cost`);

  // Fundability check: compare available_credit against the cheapest candidate.
  // Use a $0.10 buffer to avoid false-positives on rounding differences.
  const cheapestCost = parseFloat(sorted[0]?.cost_information?.monthly_cost || '0');
  const canAfford = balance ? balance.availableCredit + 0.10 >= cheapestCost : true;
  if (balance && !canAfford) {
    const err = new Error(
      `Insufficient balance: have $${balance.availableCredit.toFixed(2)}, need at least $${cheapestCost.toFixed(2)}/mo for the cheapest ${countryCode} number. ` +
      `Fund your Telnyx account at https://portal.telnyx.com/#/app/payment/billing-payments before continuing.`,
    );
    err.code = 'INSUFFICIENT_BALANCE';
    err.balance = balance;
    err.cheapestMonthlyCost = cheapestCost;
    throw err;
  }

  return { candidates: sorted, balance, canAfford, pendingConfirmation: true };
}

/**
 * Step E (after user confirms): purchase and assign to the voice app.
 * Idempotent: if the number is already owned by the account AND already
 * assigned to this voice app, treat as no-op and return outcome=found.
 */
export async function purchaseAndAssignNumber({
  fetchImpl,
  basePath,
  apiKey,
  phoneNumber,
  voiceAppId,
  log = () => {},
}) {
  if (!phoneNumber) throw new Error('purchaseAndAssignNumber requires { phoneNumber }');
  // Check whether we already own this number first (resume safety).
  const owned = await listOwnedPhoneNumbers({ fetchImpl, basePath, apiKey, limit: 100 });
  const existing = owned.find((p) => p.phone_number === phoneNumber);

  if (existing && existing.connection_id === voiceAppId) {
    log(`  ✔ Phone number            ${existing.phone_number}  already owned + assigned to this voice app (id ${existing.id})`);
    return { id: existing.id, phoneNumber: existing.phone_number, outcome: 'found', assignedTo: voiceAppId };
  }

  // Already owned (e.g. an interrupted prior run purchased it but the
  // process died before the assign PATCH) but not yet wired to THIS voice
  // app — assign it, do NOT re-purchase (that would be a second charge for
  // a number we already own; Telnyx would also just reject the order since
  // it's not available anymore).
  if (existing) {
    log(`  ${outcomeIcon('found')} Phone number            ${existing.phone_number}  already owned (id ${existing.id}) — not yet assigned to this voice app, assigning now`);
    const assign = await assignPhoneNumberToVoiceApp({
      fetchImpl, basePath, apiKey, phoneNumberId: existing.id, voiceAppId,
    });
    log(`  ${outcomeIcon('assigned')} Phone number            ${existing.phone_number}  assigned to voice app ${voiceAppId}`);
    return {
      id: existing.id, phoneNumber: existing.phone_number, outcome: 'assigned', assignedTo: voiceAppId, assignOutcome: assign.outcome,
    };
  }

  const purchase = await purchasePhoneNumber({ fetchImpl, basePath, apiKey, phoneNumber });
  log(`  ${outcomeIcon('created')} Phone number            ${purchase.phoneNumber}  (order ${purchase.orderId}, id ${purchase.phoneNumberId})  purchased`);
  const assign = await assignPhoneNumberToVoiceApp({
    fetchImpl, basePath, apiKey, phoneNumberId: purchase.phoneNumberId, voiceAppId,
  });
  log(`  ${outcomeIcon('assigned')} Phone number            ${purchase.phoneNumber}  assigned to voice app ${voiceAppId}`);
  return {
    id: purchase.phoneNumberId,
    phoneNumber: purchase.phoneNumber,
    outcome: 'created',
    assignedTo: voiceAppId,
    assignOutcome: assign.outcome,
  };
}

/**
 * Top-level orchestrator — runs Steps A-E end to end (except the user
 * confirmation between D and E, which the wizard performs out-of-band via
 * `pickPhoneNumber` + a confirm prompt, then calls `purchaseAndAssignNumber`).
 *
 * For unattended mode (`--yes-number`), pass a chosen candidate in
 * `pickedNumber: { id, phone_number }` from the answers file; the orchestrator
 * will skip the confirm step and purchase+assign in one go.
 */
export async function runTelnyxBootstrap({
  fetchImpl = fetch,
  basePath = 'https://api.telnyx.com',
  apiKey,
  deploymentName,
  baseUrl,
  pickedNumber = null, // { id, phone_number } for unattended runs
  countryCode = 'US',
  locality,
  log = () => {},
  onSubStep = () => {},
}) {
  if (!apiKey) throw new Error('runTelnyxBootstrap requires { apiKey }');
  if (!deploymentName) throw new Error('runTelnyxBootstrap requires { deploymentName }');
  if (!baseUrl) throw new Error('runTelnyxBootstrap requires { baseUrl }');

  log('');
  log(`Telnyx bootstrap — deployment "${deploymentName}", base URL ${baseUrl}`);

  const core = await ensureCoreTelnyxObjects({
    fetchImpl, basePath, apiKey, deploymentName, baseUrl, log, onSubStep,
  });

  let number = null;
  if (pickedNumber) {
    if (!pickedNumber.phone_number) {
      throw new Error('runTelnyxBootstrap: pickedNumber must include { phone_number } — available_phone_numbers results have no id field, purchase is keyed by the E.164 string itself');
    }
    // Assign straight to the Default Call Flow's dedicated voice app, NOT
    // the main WebRTC-agent voice app — this used to be a two-step dance
    // (assign to main app here, then deploy/cli/lib/call-flow.mjs's wizard
    // Step 8 re-pointed it at the flow's voice app afterward) which only
    // ever worked for the Local target. Assigning directly to the flow's
    // voice app up front removes that whole second step (and the AWS-only
    // gap it left, since Step 8 was skipped there entirely — RDS is
    // unreachable from the wizard's machine).
    number = await purchaseAndAssignNumber({
      fetchImpl, basePath, apiKey,
      phoneNumber: pickedNumber.phone_number,
      voiceAppId: core.defaultFlowVoiceApp.id,
      log,
    });
    onSubStep('phoneNumber', number);
  }

  // If the wizard will ask the user interactively, hand back the candidate
  // list separately. The wizard then calls `pickPhoneNumber` / re-runs this
  // orchestrator with `pickedNumber` set after confirmation.
  const envUpdates = { ...core.envUpdates };
  if (number) {
    envUpdates.TELNYX_MAIN_FROM_NUMBER = number.phoneNumber;
    // Telnyx resource id for the number above — read by
    // lib/seed-default-call-flow.mjs at app boot to record the
    // voice_flow_phone_numbers assignment without a second Telnyx API call.
    envUpdates.TELNYX_MAIN_FROM_NUMBER_ID = number.id;
    // Single-number deployments: reuse the same purchased number as the
    // supervisor/barge-in caller ID rather than leaving it blank (there's
    // nothing else to default it to — the wizard only ever provisions one
    // number per deployment).
    envUpdates.TELNYX_SUPERVISOR_FROM_NUMBER = number.phoneNumber;
  }

  return {
    voiceAppId: core.voiceApp.id,
    outboundVoiceProfileId: core.outboundVoiceProfile.id,
    sipConnectionId: core.sipConnection.id,
    defaultFlowVoiceAppId: core.defaultFlowVoiceApp.id,
    mediaFiles: core.mediaFiles,
    phoneNumber: number?.phoneNumber || null,
    // Telnyx-side phone number resource id (distinct from the E.164 string) —
    // recorded in state so `cc destroy`/`cc telnyx` can reference it without
    // a second lookup against /v2/phone_numbers.
    phoneNumberId: number?.id || null,
    envUpdates,
  };
}

function outcomeIcon(outcome) {
  switch (outcome) {
    case 'created': return '✔';
    case 'updated': return '✔';
    case 'found': return '✔';
    case 'assigned': return '✔';
    default: return '·';
  }
}
