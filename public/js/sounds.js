/** Small synthesized UI sounds (no audio files to download). */
let ac = null;
function ctx() {
  ac ||= new (window.AudioContext || window.webkitAudioContext)();
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  return ac;
}

function play(notes, { type = 'sine', gain = 0.06, step = 0.11, dur = 0.16 } = {}) {
  try {
    const c = ctx();
    const t0 = c.currentTime + 0.01;
    notes.forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.value = f;
      const s = t0 + i * step;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(gain, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
      o.connect(g).connect(c.destination);
      o.start(s);
      o.stop(s + dur + 0.02);
    });
  } catch { /* audio is optional */ }
}

export const sounds = {
  enabled: true,
  match() { if (this.enabled) play([587.33, 880, 1174.66], { step: 0.09 }); },
  message() { if (this.enabled) play([1046.5], { gain: 0.035, dur: 0.12 }); },
  leave() { if (this.enabled) play([523.25, 392], { type: 'triangle', gain: 0.045, step: 0.13 }); },
};
