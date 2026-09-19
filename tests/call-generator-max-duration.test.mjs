import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveRunLimits } from '../lib/call-generator/runner.mjs';
// The worker now persists a deadline before origination; no process-local hangup timer.
for(const [name,settings,run,scenario,expected] of [
 ['settings',{max_call_duration_secs:150},{},{},150],
 ['run override',{max_call_duration_secs:120},{maxDurationSecs:200},{},200],
 ['scenario override',{max_call_duration_secs:120},{},{maxCallDurationSecs:360},360],
 ['run overrides scenario',{max_call_duration_secs:120},{maxDurationSecs:45},{maxCallDurationSecs:360},45],
 ['default',{},{},{},120],
])test(`durable maximum duration: ${name}`,()=>assert.equal(effectiveRunLimits(settings,run,scenario).maxDurationSecs,expected));
