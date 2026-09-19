import { NOTIFICATION_CHANNELS, NOTIFICATION_SOUNDS, NOTIFICATION_LOOP_GAP_MS } from './notification-sounds.mjs';

// One reusable audio element: gestures unlock the same element that later
// receives offers. Never use audio.loop; the silent interval starts on ended.
const SILENCE = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
export function createNotificationSoundPlayer({
  createAudio = () => new Audio(), now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  onBlocked = () => {}, onPlaying = () => {}, onFinished = () => {}, onError = () => {},
} = {}) {
  const audio = createAudio(), heard = new Set(), failedSounds = new Set();
  let offers = [], settings = null, current = null, timer = null, expiryTimer = null;
  let blocked = false, disposed = false, priming = false, unlocked = false, generation = 0, nextAt = 0, turn = 0;
  const lastPlayed = new Map();

  function stopCurrent() {
    generation++;
    audio.onended = null; audio.onerror = null;
    audio.pause(); audio.currentTime = 0;
    current = null; onPlaying(null);
  }
  function eligible() {
    return offers.filter(offer => {
      const config = settings?.channels?.[offer.channel];
      return config?.enabled && settings.volume > 0 && offer.deadline > now();
    });
  }
  function scheduleExpiry() {
    clearTimer(expiryTimer);
    const deadlines = offers.map(offer => offer.deadline).filter(deadline => deadline > now() && Number.isFinite(deadline));
    if (deadlines.length) expiryTimer = setTimer(() => { reconcile(); scheduleExpiry(); }, Math.max(0, Math.min(...deadlines) - now()));
  }
  function finished(token) {
    if (disposed || token !== generation) return;
    const channel = current?.channel;
    stopCurrent(); nextAt = now() + NOTIFICATION_LOOP_GAP_MS; onFinished(channel); pump();
  }
  function failed(error, token, offer) {
    if (disposed || token !== generation) return;
    stopCurrent();
    if (error?.name === 'NotAllowedError') { blocked = true; onBlocked(true); }
    else { failedSounds.add(`${offer.id}:${settings.channels[offer.channel].sound}`); onError(error); nextAt = now() + NOTIFICATION_LOOP_GAP_MS; }
    pump();
  }
  function pump() {
    clearTimer(timer); timer = null;
    if (disposed || current || priming || blocked) return;
    const pending = eligible().filter(offer => !failedSounds.has(`${offer.id}:${settings.channels[offer.channel].sound}`)
      && (settings.channels[offer.channel].loop || !heard.has(offer.id)))
      .sort((a, b) => (lastPlayed.get(a.id) || 0) - (lastPlayed.get(b.id) || 0));
    if (!pending.length) return;
    if (now() < nextAt) { timer = setTimer(pump, nextAt - now()); return; }
    const offer = pending[0], config = settings.channels[offer.channel];
    const sound = NOTIFICATION_SOUNDS.find(item => item.id === config.sound);
    if (!sound) return;
    current = { ...offer, sound: config.sound };
    const token = ++generation;
    audio.src = sound.src; audio.volume = settings.volume / 100; audio.loop = false;
    audio.onended = () => finished(token);
    audio.onerror = () => failed(new Error(`Could not play ${sound.name}`), token, offer);
    Promise.resolve(audio.play()).then(() => {
      if (disposed || token !== generation) return;
      unlocked = true; heard.add(offer.id); lastPlayed.set(offer.id, ++turn);
      onBlocked(false); onPlaying(offer.channel);
    }).catch(error => failed(error, token, offer));
  }
  function reconcile() {
    const valid = eligible();
    if (current && !valid.some(offer => offer.id === current.id && settings.channels[offer.channel].sound === current.sound)) stopCurrent();
    if (current) audio.volume = settings.volume / 100;
    if (!valid.length && blocked) { blocked = false; onBlocked(false); }
    pump();
  }
  return {
    update(interactions, value) {
      if (disposed) return;
      settings = value;
      offers = (interactions || []).filter(item => NOTIFICATION_CHANNELS.includes(item.channel)
        && ['ringing', 'offered'].includes(item.state) && item.offer_id)
        .map(item => ({ id: String(item.offer_id), channel: item.channel,
          deadline: item.offer_deadline ? Date.parse(item.offer_deadline) : Infinity }));
      const ids = new Set(offers.map(offer => offer.id));
      for (const id of heard) if (!ids.has(id)) { heard.delete(id); lastPlayed.delete(id); }
      for (const key of failedSounds) if (!offers.some(offer => key === `${offer.id}:${settings?.channels?.[offer.channel]?.sound}`)) failedSounds.delete(key);
      reconcile(); scheduleExpiry();
    },
    unlock() {
      if (disposed || current || priming) return;
      if (unlocked && !blocked) return;
      blocked = false; onBlocked(false);
      if (eligible().length) { nextAt = 0; pump(); return; }
      if (unlocked) return;
      priming = true;
      const token = ++generation;
      audio.src = SILENCE;
      Promise.resolve(audio.play()).then(() => { unlocked = true; }).catch(() => {})
        .finally(() => {
          if (disposed || token !== generation) return;
          audio.pause(); audio.currentTime = 0; priming = false; pump();
        });
    },
    dispose() {
      disposed = true; clearTimer(timer); clearTimer(expiryTimer); stopCurrent();
    },
  };
}
