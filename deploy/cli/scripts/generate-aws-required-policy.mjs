#!/usr/bin/env node
// Regenerates deploy/terraform/aws-required-policy.json from the single
// source of truth in deploy/cli/lib/aws-iam-check.mjs's ACTION_GROUPS. Run
// this whenever ACTION_GROUPS changes so the printable policy document
// handed to a user's AWS admin never drifts from what checkAwsIamPermissions
// actually probes (plan §4g).
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateRequiredPolicyJson } from '../lib/aws-iam-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '..', '..', 'terraform', 'aws-required-policy.json');

const policy = generateRequiredPolicyJson({ deploymentNamePattern: '<deployment-name>-*' });
await writeFile(outPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outPath}`);
