import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  AZURE_POPULAR_REGIONS, AZURE_REGIONS_FALLBACK, resolveValidAzureRegions,
} from '../lib/azure-regions.mjs';

describe('azure-regions.mjs — AZURE_POPULAR_REGIONS', () => {
  it('every popular region value (besides the Other sentinel) is present in the fallback snapshot', () => {
    const fallbackSet = new Set(AZURE_REGIONS_FALLBACK);
    for (const { value } of AZURE_POPULAR_REGIONS) {
      if (value === '__other__') continue;
      assert.ok(fallbackSet.has(value), `${value} from AZURE_POPULAR_REGIONS is missing from AZURE_REGIONS_FALLBACK`);
    }
  });

  it('ends with the Other escape hatch, matching the AWS/GCP menu shape', () => {
    assert.strictEqual(AZURE_POPULAR_REGIONS.at(-1).value, '__other__');
  });
});

describe('azure-regions.mjs — resolveValidAzureRegions', () => {
  it('uses the live `az account list-locations` result when the call succeeds', async () => {
    let seenArgs = null;
    const execImpl = async (cmd, args) => {
      seenArgs = args;
      return { stdout: JSON.stringify(['eastus', 'westeurope', 'brandnewregion']) };
    };
    const result = await resolveValidAzureRegions({ execImpl });
    assert.deepStrictEqual(seenArgs.slice(0, 2), ['account', 'list-locations']);
    assert.ok(result.has('brandnewregion'), 'a region only present in the live list must be included');
    assert.strictEqual(result.size, 3);
  });

  it('falls back to the built-in snapshot when the az call throws (az not installed / not logged in)', async () => {
    const execImpl = async () => { throw new Error('az: command not found'); };
    const result = await resolveValidAzureRegions({ execImpl });
    assert.ok(result.has('eastus'));
    assert.ok(result.has('westeurope'));
    assert.strictEqual(result.size, AZURE_REGIONS_FALLBACK.length);
  });

  it('falls back to the built-in snapshot when az returns an empty/malformed list', async () => {
    const execImpl = async () => ({ stdout: '[]' });
    const result = await resolveValidAzureRegions({ execImpl });
    assert.strictEqual(result.size, AZURE_REGIONS_FALLBACK.length);
  });

  it('logs a warning via io when falling back, without throwing', async () => {
    const logs = [];
    const execImpl = async () => { throw new Error('network down'); };
    const io = { log: (msg) => logs.push(msg) };
    const result = await resolveValidAzureRegions({ execImpl, io });
    assert.ok(result.has('eastus'));
    assert.ok(logs.some((l) => l.includes('Could not verify Azure regions live')));
  });
});
