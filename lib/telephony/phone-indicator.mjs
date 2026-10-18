import { recoveryBadge } from './call-recovery.mjs';
import { qualityRating } from './quality.mjs';
import { sourceText } from '../i18n/source-text.mjs';

export function phoneIndicator({status, recovery, quality, deviceSelectionRequired = false, now = Date.now()}, tUi = sourceText) {
  const rawBadge = recoveryBadge(recovery?.state, status);
  const badge = {...rawBadge, label: tUi(rawBadge.label), description: tUi(rawBadge.description)};
  if (badge.tone === 'error' || badge.tone === 'offline') return {...badge, color: 'red'};
  if (badge.tone === 'warning') return {...badge, color: 'orange'};
  if (deviceSelectionRequired) return {tone: 'warning', color: 'orange', label: tUi('Choose a device'),
    description: tUi('Choose a call device before receiving voice calls.')};
  if (!quality?.active) return {...badge, color: 'green'};
  const sample = quality.samples?.at(-1);
  const fresh = sample && now - sample.timestamp >= 0 && now - sample.timestamp < 12000;
  const mos = sample?.mos;
  if (!fresh || !Number.isFinite(mos) || mos < 1 || mos > 5) {
    return {...badge, color: 'yellow', label: tUi('Waiting for measurements'),
      description: tUi('Voice is connected. Waiting for fresh audio quality statistics.')};
  }
  return {tone: 'ready', color: mos >= 4.1 ? 'green' : mos >= 3.7 ? 'yellow' : mos >= 3.1 ? 'orange' : 'red',
    label: tUi('{value0} audio quality', {value0: tUi(qualityRating(mos))}),
    description: tUi('Estimated MOS {value0} / 5 · This browser’s audio.', {value0: mos.toFixed(1)})};
}

export function hasLiveVoiceCall(store, client) {
  const terminal = state => ['idle', 'ended', 'hangup', 'destroy', 'purge', 'done', 'terminated', 'failed', 'disconnected'].includes(String(state || '').toLowerCase());
  if (store?.status && !terminal(store.status)) return true;
  if (store?.call && !terminal(store.call.state)) return true;
  return Object.values(client?.calls || {}).some(call => call && !terminal(call.state));
}
