import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DEFAULT_NOTIFICATION_SOUNDS, NOTIFICATION_SOUNDS, parseNotificationSounds, notificationSoundsFromAppSettings, parseNotificationSoundOverrides, mergeNotificationSounds, notificationSoundOverridesFrom } from '../lib/contact-center/notification-sounds.mjs';
import { createNotificationSoundPlayer } from '../lib/contact-center/notification-sound-player.mjs';

const config = (patch = {}) => ({ ...structuredClone(DEFAULT_NOTIFICATION_SOUNDS), ...patch });
const offer = (id = 'one', channel = 'email', extra = {}) => ({ offer_id: id, channel, state: 'ringing', ...extra });
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function fixture() {
  let time = 0, sequence = 0, denied = false;
  const timers = new Map(), plays = [], blocked = [];
  const audio = { src: '', currentTime: 0, volume: 1, loop: false, paused: true,
    pause() { this.paused = true; },
    play() { if (denied) return Promise.reject(Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' }));
      this.paused = false; plays.push({ src: this.src, at: time, volume: this.volume }); return Promise.resolve(); },
  };
  const player = createNotificationSoundPlayer({ createAudio: () => audio, now: () => time,
    setTimer: (fn, ms) => { timers.set(++sequence, { fn, at: time + ms }); return sequence; }, clearTimer: id => timers.delete(id), onBlocked: value => blocked.push(value) });
  async function advance(ms) {
    const end = time + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    time = end; await flush();
  }
  return { audio, player, plays, blocked, advance, timers, deny: value => { denied = value; }, finish: () => audio.onended?.() };
}

test('ten distinct original PCM tones have the declared duration, no clipping, and fade at their boundaries', async () => {
  const hashes = new Set();
  for (const sound of NOTIFICATION_SOUNDS) {
    const bytes = await readFile(new URL(`../public${sound.src}`, import.meta.url));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(bytes.readUInt16LE(20), 1); assert.equal(bytes.readUInt16LE(34), 16);
    assert.equal(bytes.readUInt32LE(40) / bytes.readUInt32LE(28), sound.duration);
    assert(sound.duration >= 3 && sound.duration <= 5);
    const samples = Array.from({ length: (bytes.length - 44) / 2 }, (_, i) => bytes.readInt16LE(44 + i * 2));
    assert(samples.some(sample => Math.abs(sample) > 10000));
    assert(samples.every(sample => Math.abs(sample) < 32767));
    assert.equal(samples[0], 0); assert.equal(samples.at(-1), 0);
    hashes.add(createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(hashes.size, 10);
});

test('strict writes reject invalid sounds, toggles, volume and arbitrary URLs; safe reads recover defaults', () => {
  assert.deepEqual(notificationSoundsFromAppSettings(null), config());
  for (const invalid of [null, {}, { ...config(), volume: 101 }, { ...config(), volume: '75' }, { ...config(), volume: 0.5 },
    { ...config(), channels: { email: { enabled: 'yes', loop: true, sound: 'glass' } } }]) assert.throws(() => parseNotificationSounds(invalid));
  // A save from a page opened before the video channel existed omits it: video keeps its default.
  const legacy = config(); delete legacy.channels.video;
  assert.deepEqual(parseNotificationSounds(legacy).channels.video, DEFAULT_NOTIFICATION_SOUNDS.channels.video);
  const input = config(); input.channels.email.sound = 'https://untrusted.example/sound.wav';
  assert.throws(() => parseNotificationSounds(input));
  assert.equal(notificationSoundsFromAppSettings({ notification_sounds: input }).channels.email.sound, 'glass');
  const result = parseNotificationSounds(config()); result.channels.email.sound = 'pulse';
  assert.equal(DEFAULT_NOTIFICATION_SOUNDS.channels.email.sound, 'glass');
});

test('one-shot playback happens once per offer despite polling; a new offer for the same interaction rings again', async () => {
  const f = fixture(), settings = config(); settings.channels.email.loop = false;
  f.player.update([offer()], settings); await flush(); assert.equal(f.plays.length, 1);
  f.finish(); await f.advance(5000);
  f.player.update([offer()], settings); await flush(); assert.equal(f.plays.length, 1);
  f.player.update([offer('second')], settings); await flush(); assert.equal(f.plays.length, 2);
  f.player.dispose();
});

test('loop waits one full second after ended, and user gestures cannot shorten the gap', async () => {
  const f = fixture(); f.player.update([offer()], config()); await flush();
  await f.advance(3200); f.finish();
  await f.advance(500); f.player.unlock();
  await f.advance(499); assert.equal(f.plays.length, 1);
  await f.advance(1); assert.equal(f.plays.length, 2); assert.equal(f.plays[1].at, 4200);
  f.player.dispose();
});

test('acceptance, withdrawal, disabled sound, lost connection and unmount cancel audio and queued repeats', async () => {
  for (const end of ['accepted', 'withdrawn', 'disabled', 'disconnected', 'unmounted']) {
    const f = fixture(); f.player.update([offer()], config()); await flush();
    if (end === 'unmounted') f.player.dispose();
    else if (end === 'disabled') { const settings = config(); settings.channels.email.enabled = false; f.player.update([offer()], settings); }
    else f.player.update(end === 'accepted' ? [offer('one', 'email', { state: 'active' })] : [], config());
    assert.equal(f.audio.paused, true, end); await f.advance(10000); assert.equal(f.plays.length, 1, end);
    f.player.dispose();
  }
});

test('offer deadline stops playback locally even if no refreshed API response arrives', async () => {
  const f = fixture(); f.player.update([offer('one', 'email', { offer_deadline: new Date(900).toISOString() })], config());
  await flush(); await f.advance(900); assert.equal(f.audio.paused, true);
  await f.advance(5000); assert.equal(f.plays.length, 1); f.player.dispose();
});

test('simultaneous channels play serially and fairly; voice, queued and active interactions do not ring', async () => {
  const f = fixture(); f.player.update([offer('voice', 'voice'), offer('queued', 'chat', { state: 'queued' }), offer('active', 'email', { state: 'active' }), offer('one', 'email'), offer('two', 'chat')], config());
  await flush(); assert.equal(f.plays.length, 1); assert.match(f.plays[0].src, /glass/);
  f.finish(); await f.advance(1000); assert.match(f.plays[1].src, /marimba/);
  f.finish(); await f.advance(1000); assert.match(f.plays[2].src, /glass/); f.player.dispose();
});

test('autoplay refusal keeps the offer pending and a gesture retries; removed offers are never replayed', async () => {
  const f = fixture(); f.deny(true); f.player.update([offer()], config()); await flush();
  assert.equal(f.blocked.at(-1), true); assert.equal(f.plays.length, 0);
  f.deny(false); f.player.unlock(); await flush(); assert.equal(f.plays.length, 1); assert.equal(f.blocked.at(-1), false);
  f.player.update([], config()); f.player.dispose();
  const g = fixture(); g.deny(true); g.player.update([offer()], config()); await flush(); g.player.update([], config());
  g.deny(false); g.player.unlock(); await flush(); assert(g.plays.every(play => play.src.startsWith('data:'))); g.player.dispose();
});

test('changing the saved channel sound replaces playback; volume zero mutes and prevents loops', async () => {
  const f = fixture(), settings = config(); f.player.update([offer()], settings); await flush();
  settings.channels.email.sound = 'beacon'; settings.volume = 40; f.player.update([offer()], settings); await flush();
  assert.match(f.plays[1].src, /beacon/); assert.equal(f.plays[1].volume, 0.4);
  f.player.update([offer()], { ...settings, volume: 0 }); await f.advance(5000); assert.equal(f.audio.paused, true); assert.equal(f.plays.length, 2); f.player.dispose();
});

test('future messaging channels can use the same configured notification lifecycle', async () => {
  const f = fixture(), settings = config(); settings.channels.whatsapp.enabled = true;
  f.player.update([offer('wa', 'whatsapp')], settings); await flush(); assert.match(f.plays[0].src, /aurora/);
  f.player.dispose();
});

test('a user keeps the system settings except the fields they changed', () => {
  const system = config({ volume: 60 });
  assert.equal(parseNotificationSoundOverrides(null), null);
  assert.equal(parseNotificationSoundOverrides({}), null);
  assert.equal(parseNotificationSoundOverrides({ channels: { video: {} } }), null);
  for (const invalid of ['x', { volume: 101 }, { channels: { chat: { sound: 'nope' } } }, { channels: { email: { enabled: 'yes' } } }]) assert.throws(() => parseNotificationSoundOverrides(invalid));
  const overrides = parseNotificationSoundOverrides({ volume: 20, channels: { chat: { sound: 'orbit', enabled: false }, sms: { loop: false }, bogus: { enabled: true } } });
  assert.deepEqual(overrides, { volume: 20, channels: { chat: { sound: 'orbit', enabled: false }, sms: { loop: false } } });
  const effective = mergeNotificationSounds(system, overrides);
  assert.equal(effective.volume, 20);
  assert.deepEqual(effective.channels.chat, { enabled: false, sound: 'orbit', loop: true });
  assert.deepEqual(effective.channels.sms, { ...system.channels.sms, loop: false });
  assert.deepEqual(effective.channels.email, system.channels.email);
  // The admin later changes the system sound for email: the user follows it (not overridden).
  const changed = { ...system, channels: { ...system.channels, email: { ...system.channels.email, sound: 'bloom' } } };
  assert.equal(mergeNotificationSounds(changed, overrides).channels.email.sound, 'bloom');
  // Only differences are stored; a draft equal to the system stores nothing.
  assert.deepEqual(notificationSoundOverridesFrom(system, effective), overrides);
  assert.equal(notificationSoundOverridesFrom(system, mergeNotificationSounds(system, null)), null);
});
