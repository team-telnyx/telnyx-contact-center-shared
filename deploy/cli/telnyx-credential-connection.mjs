#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import {
  auditCredentialConnection,
  repairCredentialConnection,
} from './lib/telnyx-credential-connection-repair.mjs';

function usage() {
  console.log(`Usage:
  telnyx-credential-connection.mjs audit  --connection-id <id>
  telnyx-credential-connection.mjs repair --connection-id <id> [--yes]

Environment:
  TELNYX_API_KEY    Required Telnyx API key
  TELNYX_BASE_PATH  Optional API base URL (defaults to https://api.telnyx.com)`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, connectionId: '', yes: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--connection-id') {
      options.connectionId = rest[++i] || '';
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printAudit(audit) {
  console.log('Telnyx Credential Connection audit');
  console.log(`  ID:                 ${audit.id}`);
  console.log(`  Name:               ${audit.name || '(not set)'}`);
  console.log(`  Current preference: ${audit.currentPreference ?? '(null)'}`);
  console.log(`  Required preference: ${audit.requiredPreference}`);
  console.log(`  Status:             ${audit.compliant ? 'COMPLIANT' : 'REPAIR REQUIRED'}`);
}

async function confirmRepair(connectionId) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Repair requires an interactive terminal or the explicit --yes flag');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Set sip_uri_calling_preference=unrestricted on ${connectionId}? [y/N] `,
    );
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.command) {
    usage();
    return;
  }
  if (!['audit', 'repair'].includes(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }

  const apiKey = process.env.TELNYX_API_KEY;
  const connectionId = options.connectionId || process.env.TELNYX_SIP_CONNECTION_ID;
  const basePath = process.env.TELNYX_BASE_PATH || 'https://api.telnyx.com';
  if (!apiKey) throw new Error('TELNYX_API_KEY is missing from the selected environment file');
  if (!connectionId) {
    throw new Error(
      'TELNYX_SIP_CONNECTION_ID is missing; set it in .env or pass --connection-id <id>',
    );
  }

  const common = { apiKey, connectionId, basePath };
  const audit = await auditCredentialConnection(common);
  printAudit(audit);

  if (options.command === 'audit') {
    if (!audit.compliant) process.exitCode = 2;
    return;
  }
  if (audit.compliant) {
    console.log('No change needed.');
    return;
  }

  const confirmed = options.yes || (await confirmRepair(connectionId));
  if (!confirmed) {
    console.log('Repair cancelled; no changes were made.');
    return;
  }

  const result = await repairCredentialConnection(common);
  console.log(
    `Repair complete and verified: ${result.after.id} now uses ${result.after.currentPreference}.`,
  );
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
