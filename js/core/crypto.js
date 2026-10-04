// Zero-knowledge vault: PBKDF2 key derivation + AES-GCM-256.
// The passphrase is never persisted anywhere — it lives in memory for the tab's lifetime.

const PBKDF2_ITERATIONS = 210_000;
const VAULT_FORMAT = 'lbvault1';

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptJSON(value, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))
  );
  return {
    format: VAULT_FORMAT,
    iterations: PBKDF2_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(new Uint8Array(ct)),
  };
}

export async function decryptJSON(envelope, passphrase) {
  if (!envelope || envelope.format !== VAULT_FORMAT) {
    throw new Error('Not a LumiBreeze vault file');
  }
  const salt = fromB64(envelope.salt);
  const iv = fromB64(envelope.iv);
  const key = await deriveKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, fromB64(envelope.ciphertext)
  );
  return JSON.parse(dec.decode(pt));
}

// A stable, non-reversible check so we can tell "wrong passphrase" apart from
// "corrupt vault" without ever storing the passphrase itself.
export async function makeVerifier(passphrase) {
  return encryptJSON({ verify: VAULT_FORMAT }, passphrase);
}

export async function checkVerifier(verifier, passphrase) {
  try {
    const out = await decryptJSON(verifier, passphrase);
    return out.verify === VAULT_FORMAT;
  } catch {
    return false;
  }
}

export function isSupported() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && !!crypto.subtle.deriveKey;
}
