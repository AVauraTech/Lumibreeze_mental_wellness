// On-device semantic memory. No network, no external model: text is embedded with a
// deterministic hashed n-gram vector and retrieved by cosine similarity from IndexedDB.
// This is a local bag-of-ngrams retriever — it finds *related* past entries, it does
// not understand language the way a transformer does.

const DIMS = 256;
const DB_NAME = 'lb_memory';
const STORE = 'entries';

const STOPWORDS = new Set(['the','a','an','and','or','but','is','are','was','were','be','to','of','in','on','at','for','with','i','my','me','it','that','this','so','just','am','do','not','you','your']);

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('ts', 'ts');
        os.createIndex('kind', 'kind');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function tokens(text) {
  return text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(w => w && !STOPWORDS.has(w));
}

// Hashed feature vector: word unigrams, word bigrams, and character trigrams.
// Character n-grams give partial matching for typos and morphological variants.
export function embed(text) {
  const vec = new Float32Array(DIMS);
  const words = tokens(text);

  for (const w of words) {
    vec[fnv1a('w:' + w) % DIMS] += 1.0;
    for (let i = 0; i + 3 <= w.length; i++) {
      vec[fnv1a('c:' + w.slice(i, i + 3)) % DIMS] += 0.35;
    }
  }
  for (let i = 0; i + 1 < words.length; i++) {
    vec[fnv1a('b:' + words[i] + '_' + words[i + 1]) % DIMS] += 0.7;
  }

  // Sublinear scaling so one repeated word cannot dominate the vector.
  for (let i = 0; i < DIMS; i++) {
    if (vec[i] > 0) vec[i] = 1 + Math.log(vec[i]);
  }
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIMS; i++) vec[i] /= norm;
  return vec;
}

export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < DIMS; i++) dot += a[i] * b[i];
  return dot; // both inputs are L2-normalised
}

export async function remember({ id, text, kind = 'journal', ts = Date.now(), meta = {} }) {
  const db = await openDB();
  const record = { id: id ?? crypto.randomUUID(), text, kind, ts, meta, vec: Array.from(embed(text)) };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve(record.id);
    tx.onerror = () => reject(tx.error);
  });
}

let cache = null;

async function loadAll() {
  if (cache) return cache;
  const db = await openDB();
  cache = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return cache;
}

export function invalidateCache() { cache = null; }

export async function recall(query, { k = 3, kinds = null, minScore = 0.18 } = {}) {
  const all = await loadAll();
  const q = embed(query);
  const scored = all
    .filter(e => !kinds || kinds.includes(e.kind))
    .map(e => ({ entry: e, score: cosine(q, Float32Array.from(e.vec)) }))
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored;
}

export async function forget(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => { invalidateCache(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

export async function wipeMemory() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => { invalidateCache(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

export async function count() {
  return (await loadAll()).length;
}

// Newest-first entries regardless of similarity — used when a recall question
// ("what do you remember?") shares no vocabulary with the stored content.
export async function latest(k = 3) {
  const all = await loadAll();
  return [...all].sort((a, b) => b.ts - a.ts).slice(0, k).map(entry => ({ entry, score: 1 }));
}

// Index anything already sitting in the store but not yet embedded — lets the
// chatbot remember mood/journal history recorded before memory was switched on.
export async function syncFromStore(journal = [], moodHistory = []) {
  let added = 0;
  const existing = await loadAll();
  const seen = new Set(existing.map(e => e.id));
  for (const j of journal) {
    if (!j?.text || seen.has(j.id)) continue;
    await remember({ id: j.id, text: j.text, kind: 'journal', ts: j.ts, meta: { mood: j.mood } });
    added++;
  }
  for (const m of moodHistory) {
    const id = 'mood:' + m.ts;
    if (seen.has(id)) continue;
    await remember({ id, text: `mood check-in rated ${m.value} out of 10`, kind: 'mood', ts: m.ts });
    added++;
  }
  invalidateCache();
  return added;
}

export function relativeTime(ts) {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${days >= 14 ? 's' : ''} ago`;
  return `${Math.floor(days / 30)} month${days >= 60 ? 's' : ''} ago`;
}
