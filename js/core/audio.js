// Procedural Web Audio. Effects are synthesised rather than fetched so gameplay
// audio stays instant and works fully offline; the mp3 files under sound/ are
// only used by calm.html's long ambient loops.

let ctx = null;
let master = null;
let enabled = true;

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setEnabled(on) {
  enabled = !!on;
  if (master) master.gain.value = enabled ? 0.35 : 0;
}

export function isEnabled() { return enabled; }

function tone({ freq = 440, dur = 0.18, type = 'sine', gain = 0.5, attack = 0.01, delay = 0, glide = null }) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noise({ dur = 0.2, gain = 0.25, filterFreq = 1200, delay = 0 }) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const t0 = c.currentTime + delay;
  const frames = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterFreq;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(master);
  src.start(t0);
}

export const sfx = {
  match: () => { tone({ freq: 660, dur: 0.12, type: 'triangle' }); tone({ freq: 990, dur: 0.22, type: 'triangle', delay: 0.09 }); },
  mismatch: () => { tone({ freq: 180, dur: 0.22, type: 'sawtooth', gain: 0.22, glide: 110 }); },
  flip: () => { noise({ dur: 0.06, gain: 0.12, filterFreq: 2600 }); },
  levelUp: () => { [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.35, delay: i * 0.09 })); },
  evolve: () => { [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone({ freq: f, dur: 0.5, type: 'sine', gain: 0.3, delay: i * 0.12 })); },
  coin: () => { tone({ freq: 1200, dur: 0.07, type: 'square', gain: 0.18 }); tone({ freq: 1600, dur: 0.12, type: 'square', gain: 0.14, delay: 0.06 }); },
  bubble: () => { tone({ freq: 400, dur: 0.18, type: 'sine', gain: 0.2, glide: 900 }); },
  alert: () => { tone({ freq: 880, dur: 0.15, type: 'sine', gain: 0.25 }); tone({ freq: 880, dur: 0.15, type: 'sine', gain: 0.25, delay: 0.25 }); },
  breathIn: () => tone({ freq: 220, dur: 3.6, type: 'sine', gain: 0.16, attack: 1.6, glide: 440 }),
  breathOut: () => tone({ freq: 330, dur: 4.4, type: 'sine', gain: 0.14, attack: 0.6, glide: 165 }),
};

// Looping ambient beds for the sanctuary. Returns a stop function.
export function ambience(kind = 'meadow') {
  const c = ensureCtx();
  if (!c) return () => {};
  const bus = c.createGain();
  bus.gain.value = 0;
  bus.connect(master);
  bus.gain.linearRampToValueAtTime(0.14, c.currentTime + 2);

  const nodes = [];
  const presets = {
    meadow: { freqs: [196, 294, 392], type: 'sine', lfo: 0.08 },
    forest: { freqs: [147, 220, 330], type: 'triangle', lfo: 0.05 },
    fairyland: { freqs: [523, 659, 880], type: 'sine', lfo: 0.14 },
    outerspace: { freqs: [98, 131, 165], type: 'sawtooth', lfo: 0.03 },
    underwater: { freqs: [110, 165, 220], type: 'sine', lfo: 0.06 },
  };
  const p = presets[kind] ?? presets.meadow;

  for (const freq of p.freqs) {
    const osc = c.createOscillator();
    osc.type = p.type;
    osc.frequency.value = freq;
    const g = c.createGain();
    g.gain.value = 0.3 / p.freqs.length;
    const lfo = c.createOscillator();
    lfo.frequency.value = p.lfo + Math.random() * 0.04;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 0.12 / p.freqs.length;
    lfo.connect(lfoGain).connect(g.gain);
    osc.connect(g).connect(bus);
    osc.start(); lfo.start();
    nodes.push(osc, lfo);
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    bus.gain.linearRampToValueAtTime(0, c.currentTime + 0.8);
    setTimeout(() => nodes.forEach(n => { try { n.stop(); } catch { /* already stopped */ } }), 900);
  };
}
