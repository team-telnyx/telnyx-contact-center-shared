export function playDtmfBeep(digit, ctxRef) {
  try {
    if (typeof window === "undefined") return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = ctxRef.current || new Ctx();
    ctxRef.current = ctx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const row = {
      1: 697,
      2: 697,
      3: 697,
      4: 770,
      5: 770,
      6: 770,
      7: 852,
      8: 852,
      9: 852,
      "*": 941,
      0: 941,
      "#": 941,
    };
    const col = {
      1: 1209,
      2: 1336,
      3: 1477,
      4: 1209,
      5: 1336,
      6: 1477,
      7: 1209,
      8: 1336,
      9: 1477,
      "*": 1209,
      0: 1336,
      "#": 1477,
    };
    const f1 = row[String(digit)] || 440;
    const f2 = col[String(digit)] || 0;
    const now = ctx.currentTime;
    const dur = 0.12;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.06, now + 0.01);
    gain.gain.setValueAtTime(0.06, now + dur - 0.02);
    gain.gain.linearRampToValueAtTime(0, now + dur);
    gain.connect(ctx.destination);
    const o1 = ctx.createOscillator();
    o1.type = "sine";
    o1.frequency.setValueAtTime(f1, now);
    o1.connect(gain);
    o1.start(now);
    o1.stop(now + dur);
    if (f2) {
      const o2 = ctx.createOscillator();
      o2.type = "sine";
      o2.frequency.setValueAtTime(f2, now);
      o2.connect(gain);
      o2.start(now);
      o2.stop(now + dur);
    }
  } catch (_) {}
}
