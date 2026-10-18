/**
 * Who is on a call being moved, and what the softphone offers for it: a
 * "Move call" bar for the call in this browser, a "Take over" banner for a
 * call of this user's on another device. Pure, for the dialog, the softphone
 * card, the mini phone and "Calls on" alike.
 */

import { sourceText } from '../i18n/source-text.mjs';

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const outbound = interaction => ['outbound', 'outgoing'].includes(String(interaction?.direction || '').toLowerCase());
const LIVE = ['active', 'connected', 'answered', 'held', 'early'];

/** The other party of an interaction: who called in, or whom this user called. */
export function interactionCaller(interaction, browserAnswerTime = null, tUi = sourceText) {
  if (!interaction) return { name: tUi('Call'), number: null, startedAt: browserAnswerTime || null };
  const name = text(outbound(interaction) ? interaction.to_name : interaction.from_name);
  const number = text(outbound(interaction) ? interaction.to_number : interaction.from_number);
  const title = name || number || tUi('Call');
  const shownNumber = number && number !== title && !number.toLowerCase().startsWith('sip:') ? number : null;
  return { name: title, number: shownNumber, startedAt: interaction.answered_at || browserAnswerTime || null };
}

/** This user's voice interactions in progress, as the agent interactions list returns them. */
export const voiceInteractions = interactions => (interactions || []).filter(i => (i.channel || i.interaction_type) === 'voice');

/**
 * What the softphone offers:
 * - { kind: 'move', interactionId }: the call in this browser can be moved.
 * - { kind: 'elsewhere', interactionId, caller, ownerLabel }: a call on another device can be taken over here.
 * - null: nothing (no call, a call still ringing or dialling, or a call the Contact Center cannot move).
 *
 * - interactions: this user's voice interactions in progress.
 * - takeOvers: what the Contact Center last said of each interaction this browser could take over,
 *   { [interactionId]: { canTakeOver, ownerLabel } } (DeviceHandoffHost reads it).
 * - callStatus: this browser's call status (active call store), or null.
 * - callInteractionId: the interaction the softphone bound to this browser's call, if any.
 */
export function handoffEntry({ interactions, takeOvers = {}, callStatus = null, callInteractionId = null, tUi = sourceText }) {
  const voice = voiceInteractions(interactions);
  if (callStatus && LIVE.includes(callStatus)) {
    const id = callInteractionId || (voice.length === 1 ? voice[0].id : null);
    return id ? { kind: 'move', interactionId: String(id) } : null;
  }
  if (callStatus && !['idle', 'ended', 'hangup', 'destroy', 'terminated', 'purge'].includes(callStatus)) return null;
  // Only where the Contact Center says it can come here: not a call that just ended in this browser.
  const elsewhere = voice.find(i => takeOvers[i.id]?.canTakeOver);
  return elsewhere ? { kind: 'elsewhere', interactionId: String(elsewhere.id), caller: interactionCaller(elsewhere, null, tUi),
    ownerLabel: takeOvers[elsewhere.id].ownerLabel || tUi('another device') } : null;
}
