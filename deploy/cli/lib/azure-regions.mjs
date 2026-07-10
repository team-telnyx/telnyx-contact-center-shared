import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// Resolves the list of valid Azure regions for the region-selection prompt
// (runRegionStep's azure branch in wizard.mjs) — mirrors
// aws-instance-connect-cidrs.mjs's shape: a curated fast-path menu for the
// common case, plus a live-verified "Other" path for anything not on that
// menu, with a built-in fallback snapshot so a network hiccup or a not-yet-
// authenticated `az` session never hard-blocks the wizard.
//
// Why this exists: AWS_REGIONS/GCP_REGIONS in wizard.mjs are curated,
// static, no-lookup menus — good enough there because both providers'
// region namespaces are small and stable. Azure has 60+ physical regions
// and (unlike AWS/GCP) ships an authoritative, per-subscription live list
// via `az account list-locations`, so free-typing a region name is far
// more error-prone (typos like "eastus2" vs "east us 2" vs "eastus-2" all
// look plausible) — this module adds real validation for that path instead
// of silently accepting whatever the user typed and letting it surface
// later as an opaque Terraform/ARM error.

// Curated "popular" menu — same rationale as AWS_REGIONS/GCP_REGIONS in
// wizard.mjs: EU + US coverage matching where Telnyx PoPs and this
// project's userbase mostly sit, not exhaustive. `az account
// list-locations --query "[?metadata.regionType=='Physical' &&
// metadata.regionCategory=='Recommended']"` was used to confirm every
// entry below is a real, currently-recommended (non-physical-only-via-
// pairing) Azure region as of 2026-07-09.
export const AZURE_POPULAR_REGIONS = [
  { label: 'westeurope — West Europe (Netherlands)', value: 'westeurope' },
  { label: 'northeurope — North Europe (Ireland)', value: 'northeurope' },
  { label: 'uksouth — UK South (London)', value: 'uksouth' },
  { label: 'swedencentral — Sweden Central', value: 'swedencentral' },
  { label: 'eastus — East US (Virginia)', value: 'eastus' },
  { label: 'eastus2 — East US 2 (Virginia)', value: 'eastus2' },
  { label: 'centralus — Central US (Iowa)', value: 'centralus' },
  { label: 'westus2 — West US 2 (Washington)', value: 'westus2' },
  { label: 'Other (type a region name)', value: '__other__' },
];

// Snapshot of every valid physical Azure region name (the `name` field
// `az account list-locations` returns, NOT displayName — Terraform's
// azurerm provider takes this short form, e.g. "eastus" not "East US"),
// captured 2026-07-09 via:
//   az account list-locations --query "[?metadata.regionType=='Physical'].name" -o tsv
// Used as the offline/unauthenticated fallback for validating a free-typed
// "Other" region when a live `az account list-locations` call isn't
// possible (az not installed/logged in yet at this point in the wizard —
// region selection runs before the Azure preflight step that actually
// checks `az` auth). New Azure regions launch a few times a year; this
// list intentionally errs toward "known-good as of capture date" rather
// than trying to be perpetually exhaustive — see resolveValidAzureRegions'
// live-lookup-first behavior below for how a brand-new region still works
// despite not being in this snapshot.
export const AZURE_REGIONS_FALLBACK = [
  'australiacentral', 'australiacentral2', 'australiaeast', 'australiasoutheast',
  'austriaeast', 'belgiumcentral', 'brazilsouth', 'brazilsoutheast',
  'canadacentral', 'canadaeast', 'centralindia', 'centralus', 'centraluseuap',
  'chilecentral', 'denmarkeast', 'eastasia', 'eastus', 'eastus2', 'eastus2euap',
  'eastusstg', 'francecentral', 'francesouth', 'germanynorth', 'germanywestcentral',
  'indonesiacentral', 'israelcentral', 'italynorth', 'japaneast', 'japanwest',
  'jioindiacentral', 'jioindiawest', 'koreacentral', 'koreasouth', 'malaysiawest',
  'mexicocentral', 'newzealandnorth', 'northcentralus', 'northeurope', 'norwayeast',
  'norwaywest', 'polandcentral', 'qatarcentral', 'southafricanorth', 'southafricawest',
  'southcentralus', 'southcentralusstg', 'southeastasia', 'southindia', 'spaincentral',
  'swedencentral', 'switzerlandnorth', 'switzerlandwest', 'uaecentral', 'uaenorth',
  'uksouth', 'ukwest', 'westcentralus', 'westeurope', 'westindia', 'westus',
  'westus2', 'westus3',
];

/**
 * Live-verified set of valid Azure region names, for validating a
 * free-typed "Other" region answer. Always tries `az account
 * list-locations` first (authoritative for whatever subscription/cloud
 * the operator is actually authenticated against — catches brand-new
 * regions this module's snapshot doesn't know about yet, and correctly
 * excludes regions the account's cloud (e.g. Azure Government) doesn't
 * expose); falls back to AZURE_REGIONS_FALLBACK on any failure (az not
 * installed, not logged in yet, network down) rather than blocking the
 * wizard on something recoverable by just proceeding — same "never let an
 * optional live-data lookup hard-fail the flow" contract as
 * resolveAdminSshCidrs in aws-instance-connect-cidrs.mjs.
 */
export async function resolveValidAzureRegions({ execImpl = execFileAsync, io } = {}) {
  try {
    const { stdout } = await execImpl('az', [
      'account', 'list-locations',
      '--query', "[?metadata.regionType=='Physical'].name",
      '--output', 'json',
    ]);
    const names = JSON.parse(stdout || '[]');
    if (Array.isArray(names) && names.length > 0) return new Set(names);
    io?.log?.('  ⚠ `az account list-locations` returned no regions — falling back to built-in snapshot.');
  } catch (err) {
    io?.log?.(`  ⚠ Could not verify Azure regions live (${err.message}) — falling back to built-in snapshot for validation.`);
  }
  return new Set(AZURE_REGIONS_FALLBACK);
}
