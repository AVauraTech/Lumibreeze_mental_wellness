// Shared reactive store for every LumiBreeze page.
// Replaces the scattered per-page localStorage keys with one synced source of truth.

import { encryptJSON, decryptJSON, makeVerifier, checkVerifier, isSupported } from './crypto.js';

const PLAIN_KEY = 'lb_state_v2';
const VAULT_KEY = 'lb_vault_v2';
const CHANNEL = 'lb_sync_v2';

export const STAGES = ['Baby', 'Child', 'Teen', 'Adult', 'Evolved'];

// Evolution thresholds: [gems, coins] required to reach that stage.
const STAGE_GATES = [
  [0, 0],
  [100, 1000],
  [200, 2000],
  [300, 3000],
  [400, 4000],
];

export const ACCESSORIES = [
  { id: 'hat', name: 'Hat', src: 'https://cdn-icons-png.flaticon.com/256/6240/6240471.png' },
  { id: 'scarf', name: 'Scarf', src: 'https://cdn-icons-png.flaticon.com/256/10142/10142747.png' },
  { id: 'glasses', name: 'Glasses', src: 'https://cdn-icons-png.flaticon.com/256/8089/8089203.png' },
  { id: 'wand', name: 'Magic Wand', src: 'https://cdn-icons-png.flaticon.com/256/10096/10096798.png' },
  { id: 'bowtie', name: 'Bow Tie', src: 'https://cdn-icons-png.flaticon.com/256/11218/11218194.png' },
  { id: 'crown', name: 'Crown', src: 'https://cdn-icons-png.flaticon.com/256/7602/7602760.png' },
];

export const BIOMES = [
  { id: 'meadow', name: 'Meadow', ground: 0x6fbf73, sky: 0x9fd8ff, accent: 0xffd86b },
  { id: 'fairyland', name: 'Fairyland', ground: 0xd7a7f0, sky: 0xffd6f5, accent: 0xfff0a8 },
  { id: 'forest', name: 'Forest', ground: 0x3f7d44, sky: 0xbfe6c4, accent: 0xffb347 },
  { id: 'outerspace', name: 'Outerspace', ground: 0x2b2350, sky: 0x0a0820, accent: 0x9d7bff },
  { id: 'underwater', name: 'Underwater', ground: 0x2f7f9c, sky: 0x0d3b52, accent: 0x7bffe4 },
];

function defaultState() {
  return {
    version: 2,
    updatedAt: Date.now(),
    profile: { name: 'Explorer', persona: 'student' },
    pet: {
      name: '',
      species: 'lumi',
      stage: 0,
      xp: 0,
      xpLifetime: 0,
      hunger: 60,
      thirst: 60,
      happiness: 70,
      energy: 70,
      cleanliness: 80,
      health: 90,
      biome: 'meadow',
      personality: { empathy: 0.5, playfulness: 0.5, calm: 0.5 },
    },
    economy: { coins: 100, gems: 0 },
    unlockedAccessories: ['hat'],
    habits: [],
    habitLog: {},
    streak: { count: 0, lastDate: null },
    mood: { history: [], lastValue: 5, lastDate: null, streak: 0 },
    journal: [],
    dda: { level: 0, games: 0, wins: 0, accuracy: 0, avgLatency: 0, stress: 0 },
    biometrics: { source: 'none', hrv: null, heartRate: null, samples: [] },
    settings: { sound: true, encryption: false, quality: 'high', decay: true },
    events: [],
  };
}

const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

let state = defaultState();
const listeners = new Set();
let channel = null;
let saveTimer = null;
let passphrase = null;
let readyPromise = null;

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = k in base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
      ? mergeDeep(base[k], patch[k])
      : patch[k];
  }
  return out;
}

function emit(reason) {
  for (const fn of listeners) {
    try { fn(state, reason); } catch (e) { console.error('[store] listener failed', e); }
  }
}

function broadcast(payload) {
  if (channel) {
    try { channel.postMessage(payload); } catch { /* channel closed */ }
  }
}

export async function persist() {
  state.updatedAt = Date.now();
  if (state.settings.encryption && passphrase && isSupported()) {
    const envelope = await encryptJSON(state, passphrase);
    localStorage.setItem(VAULT_KEY, JSON.stringify(envelope));
    localStorage.removeItem(PLAIN_KEY);
  } else {
    localStorage.setItem(PLAIN_KEY, JSON.stringify(state));
  }
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persist().catch(e => console.warn('[store] persist failed', e));
  }, 250);
}

export function setState(mutator, reason = 'local', sync = true) {
  const draft = structuredClone(state);
  mutator(draft);
  state = draft;
  if (sync && reason !== 'remote') broadcast({ type: 'state', state });
  emit(reason);
  schedulePersist();
}

export function getState() { return state; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- Vitals decay -------------------------------------------------------
// Stats drift down with real elapsed time, including time spent offline.
const DECAY_PER_HOUR = { hunger: 5, thirst: 6, happiness: 3.5, energy: 4, cleanliness: 3, health: 1.5 };

export function applyDecay(now = Date.now()) {
  if (!state.settings.decay) return;
  const hours = Math.min((now - state.updatedAt) / 3_600_000, 72); // cap catch-up at 3 days
  if (hours < 0.001) return;
  setState(s => {
    for (const [stat, rate] of Object.entries(DECAY_PER_HOUR)) {
      s.pet[stat] = clamp(s.pet[stat] - rate * hours);
    }
    const avg = (s.pet.hunger + s.pet.thirst + s.pet.happiness + s.pet.energy + s.pet.cleanliness) / 5;
    // Health tracks how well the pet is being cared for, and recovers when it is.
    s.pet.health = clamp(s.pet.health + (avg > 60 ? 0.5 * hours : -1.2 * hours));
  }, 'decay');
}

// ---- Progression --------------------------------------------------------

export function gainXP(amount) {
  let levelled = false;
  setState(s => {
    s.pet.xp += amount;
    s.pet.xpLifetime += amount;
    while (s.pet.xp >= 100) {
      s.pet.xp -= 100;
      s.economy.gems += 1;
      levelled = true;
    }
    recomputeStage(s);
  }, 'xp');
  return levelled;
}

function recomputeStage(s) {
  let target = 0;
  for (let i = 0; i < STAGE_GATES.length; i++) {
    if (s.economy.gems >= STAGE_GATES[i][0] && s.economy.coins >= STAGE_GATES[i][1]) target = i;
  }
  if (target > s.pet.stage) {
    s.pet.stage = target;
    s.events.push({ ts: Date.now(), type: 'evolve', stage: target });
    const reward = ACCESSORIES[target];
    if (reward && !s.unlockedAccessories.includes(reward.id)) {
      s.unlockedAccessories.push(reward.id);
    }
  }
}

export function recordHabit(title) {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  let kept = false;
  setState(s => {
    s.habitLog[today] = s.habitLog[today] || [];
    s.habitLog[today].push({ title, ts: Date.now() });
    if (s.streak.lastDate !== today) {
      s.streak.count = s.streak.lastDate === yesterday ? s.streak.count + 1 : 1;
      s.streak.lastDate = today;
      kept = true;
    }
    s.pet.happiness = clamp(s.pet.happiness + 6);
    s.pet.health = clamp(s.pet.health + 2);
  }, 'habit');
  if (kept) gainXP(10);
  return kept;
}

export function addJournalEntry(text, moodValue) {
  const entry = { id: crypto.randomUUID(), ts: Date.now(), text, mood: moodValue ?? null };
  setState(s => {
    s.journal.push(entry);
    if (s.journal.length > 500) s.journal.splice(0, s.journal.length - 500);
    if (moodValue != null) {
      s.mood.history.push({ ts: entry.ts, value: moodValue });
      if (s.mood.history.length > 365) s.mood.history.shift();
      s.mood.lastValue = moodValue;
    }
  }, 'journal');
  return entry;
}

export function nudgePersonality(trait, delta) {
  setState(s => {
    if (trait in s.pet.personality) {
      s.pet.personality[trait] = clamp(s.pet.personality[trait] + delta, 0, 1);
    }
  }, 'personality');
}

// Telemetry arrives ~1Hz, so it mutates in place and throttles writes instead of
// cloning and broadcasting the whole vault (including the journal) every second.
let bioPersistAt = 0;
export function logBiometric(sample) {
  const stamped = { ...sample, ts: Date.now() };
  state.biometrics = { ...state.biometrics, ...sample, at: stamped.ts };
  state.biometrics.samples = [...state.biometrics.samples, stamped].slice(-120);
  emit('biometric');
  if (stamped.ts - bioPersistAt > 10_000) {
    bioPersistAt = stamped.ts;
    schedulePersist();
  }
}

export function stageName(s = state) { return STAGES[s.pet.stage]; }
export function stageImage(s = state) { return `image/lumi${s.pet.stage + 1}.jpg`; }
export function biomeById(id) { return BIOMES.find(b => b.id === id) ?? BIOMES[0]; }

// ---- Encryption controls ------------------------------------------------

export async function enableEncryption(newPassphrase) {
  if (!isSupported()) throw new Error('WebCrypto unavailable — serve over http://localhost or https://');
  passphrase = newPassphrase;
  const verifier = await makeVerifier(newPassphrase);
  setState(s => { s.settings.encryption = true; }, 'settings');
  localStorage.setItem(VAULT_KEY + '_verifier', JSON.stringify(verifier));
  await persist();
}

export function disableEncryption() {
  passphrase = null;
  setState(s => { s.settings.encryption = false; }, 'settings');
  localStorage.removeItem(VAULT_KEY);
  localStorage.removeItem(VAULT_KEY + '_verifier');
  persist();
}

export function isEncryptionEnabled() {
  return !!localStorage.getItem(VAULT_KEY + '_verifier');
}

// Encryption is on but this session has not been given the passphrase yet,
// so the live state is still the empty default.
export function isLocked() {
  return isEncryptionEnabled() && passphrase == null;
}

export async function unlock(newPassphrase) {
  const verifier = JSON.parse(localStorage.getItem(VAULT_KEY + '_verifier') || 'null');
  if (!verifier) return true;
  if (!(await checkVerifier(verifier, newPassphrase))) return false;
  passphrase = newPassphrase;
  const envelope = JSON.parse(localStorage.getItem(VAULT_KEY) || 'null');
  if (envelope) state = mergeDeep(defaultState(), await decryptJSON(envelope, newPassphrase));
  emit('unlock');
  return true;
}

export function exportVault() {
  const raw = localStorage.getItem(VAULT_KEY);
  if (raw) return JSON.parse(raw);
  return { format: 'lbplain1', state };
}

export function importVault(envelope, importPassphrase) {
  if (envelope.format === VAULT_FORMAT) return decryptJSON(envelope, importPassphrase);
  if (envelope.format === 'lbplain1') return Promise.resolve(envelope.state);
  return Promise.reject(new Error('Unrecognised file format'));
}

// ---- Legacy migration ---------------------------------------------------
// Pulls in the pre-v2 per-page keys so nobody loses existing progress.
function migrateLegacy() {
  let touched = false;
  const old = localStorage.getItem('lumipet2_state');
  if (old) {
    try {
      const p = JSON.parse(old);
      if (p?.pet) {
        state.pet = mergeDeep(state.pet, { ...p.pet, evolutionStages: undefined });
        state.economy = { coins: p.coins ?? 100, gems: p.gems ?? 0 };
        state.habits = p.habits ?? [];
        state.streak.count = p.streak ?? 0;
        touched = true;
      }
    } catch { /* ignore malformed legacy blob */ }
    localStorage.removeItem('lumipet2_state');
  }
  const moodData = localStorage.getItem('moodData');
  if (moodData) {
    try {
      const arr = JSON.parse(moodData);
      if (Array.isArray(arr) && arr.length && !state.mood.history.length) {
        state.mood.history = arr.map((value, i) => ({ ts: Date.now() - (arr.length - i) * 86_400_000, value }));
        touched = true;
      }
    } catch { /* ignore */ }
  }
  return touched;
}

async function boot() {
  try { channel = new BroadcastChannel(CHANNEL); } catch { channel = null; }
  if (channel) {
    channel.onmessage = (e) => {
      if (e.data?.type === 'state') {
        state = mergeDeep(state, e.data.state);
        emit('remote');
      }
    };
  }

  const plain = localStorage.getItem(PLAIN_KEY);
  if (plain) {
    try { state = mergeDeep(defaultState(), JSON.parse(plain)); } catch { /* fall back to defaults */ }
  }
  if (migrateLegacy()) await persist();

  window.addEventListener('beforeunload', () => { persist(); });
  applyDecay();

  // Keep vitals live while the page is open.
  setInterval(() => applyDecay(), 60_000);
  // Keep background tabs honest when they regain focus.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) applyDecay();
  });
}

export const ready = readyPromise ?? (readyPromise = boot());
