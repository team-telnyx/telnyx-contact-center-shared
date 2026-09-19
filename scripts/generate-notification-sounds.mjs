// Original synthesized notification tones: no third-party samples or licences.
// Run from any directory with `node scripts/generate-notification-sounds.mjs`.
import { mkdir, writeFile } from 'node:fs/promises';
import { NOTIFICATION_SOUNDS } from '../lib/contact-center/notification-sounds.mjs';

const rate = 32000;
const motifs = {
  glass:    { notes: [76, 83, 88], spacing: 0.55, decay: 0.75, harmonics: [1, 0.16, 0.04] },
  marimba:  { notes: [60, 67, 72, 67], spacing: 0.48, decay: 0.42, harmonics: [1, 0.12, 0.3] },
  aurora:   { notes: [64, 71, 76], spacing: 0.66, decay: 1.1, harmonics: [1, 0.25, 0.1] },
  pulse:    { notes: [69, 69, 76, 76], spacing: 0.42, decay: 0.3, harmonics: [1, 0.3, 0.08] },
  doorbell: { notes: [76, 71, 76, 71], spacing: 0.55, decay: 0.58, harmonics: [1, 0.45, 0.15] },
  orbit:    { notes: [72, 79, 76, 84], spacing: 0.5, decay: 0.7, harmonics: [1, 0.08, 0.22] },
  cascade:  { notes: [88, 83, 79, 76, 72], spacing: 0.38, decay: 0.68, harmonics: [1, 0.15, 0.1] },
  beacon:   { notes: [67, 74, 67], spacing: 0.65, decay: 0.45, harmonics: [1, 0.5, 0.15] },
  bloom:    { notes: [60, 64, 67, 72], spacing: 0.53, decay: 0.95, harmonics: [1, 0.22, 0.09] },
  digital:  { notes: [81, 76, 81, 88], spacing: 0.39, decay: 0.46, harmonics: [1, 0.32, 0.18] },
};
const output = new URL('../public/audio/notifications/', import.meta.url);
await mkdir(output, { recursive: true });
for (const sound of NOTIFICATION_SOUNDS) {
  const motif = motifs[sound.id], count = Math.round(rate * sound.duration), samples = new Float64Array(count);
  for (let index = 0; index < motif.notes.length; index++) {
    const start = 0.04 + index * motif.spacing, frequency = 440 * 2 ** ((motif.notes[index] - 69) / 12);
    for (let i = Math.floor(start * rate); i < count; i++) {
      const t = i / rate - start;
      if (t < 0) continue;
      const envelope = Math.min(1, t / 0.012) * Math.exp(-t * 4 / motif.decay);
      const tail = Math.min(1, (count - 1 - i) / (rate * 0.08));
      samples[i] += motif.harmonics.reduce((sum, amplitude, harmonic) => sum + amplitude * Math.sin(2 * Math.PI * frequency * (harmonic + 1) * t), 0) * envelope * tail;
    }
  }
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0), wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(samples[i] / peak * 18000), 44 + i * 2);
  await writeFile(new URL(`${sound.id}.wav`, output), wav);
}
