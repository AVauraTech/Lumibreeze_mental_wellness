// Biometric input. Real path: Web Bluetooth Heart Rate Service (0x180D), which
// streams RR intervals from chest straps and most fitness watches. Fallback path:
// a clearly-labelled simulator so the stress-reactive features are usable without hardware.

import { logBiometric, getState, nudgePersonality } from './store.js';

const HR_SERVICE = 0x180d;
const HR_MEASUREMENT = 0x2a37;

const listeners = new Set();
let source = 'none';
let device = null;
let simTimer = null;
let rrWindow = [];

export function onReading(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getSource() { return source; }
export function isSupported() { return 'bluetooth' in navigator && 'requestDevice' in navigator.bluetooth; }

function emit(reading) {
  for (const fn of listeners) {
    try { fn(reading); } catch (e) { console.error('[biometrics] listener failed', e); }
  }
}

// RMSSD over the recent RR window — the standard short-term HRV metric.
function computeHRV(rrMs) {
  if (rrMs.length < 4) return null;
  let sum = 0;
  for (let i = 1; i < rrMs.length; i++) {
    const d = rrMs[i] - rrMs[i - 1];
    sum += d * d;
  }
  return Math.sqrt(sum / (rrMs.length - 1));
}

// Normalised 0..1 stress estimate. Low HRV with an elevated heart rate reads as stress.
export function stressScore({ heartRate, hrv }) {
  if (heartRate == null) return null;
  const hrPart = Math.min(1, Math.max(0, (heartRate - 60) / 50));
  const hrvPart = hrv == null ? 0.5 : Math.min(1, Math.max(0, 1 - (hrv - 15) / 65));
  return Math.round((0.45 * hrPart + 0.55 * hrvPart) * 100) / 100;
}

function pushRR(rrMs) {
  rrWindow.push(rrMs);
  if (rrWindow.length > 24) rrWindow.shift();
}

function parseHeartRateMeasurement(view) {
  const flags = view.getUint8(0);
  let offset = 1;
  const hr16 = (flags & 0x01) !== 0;
  const heartRate = hr16 ? view.getUint16(offset, true) : view.getUint8(offset);
  offset += hr16 ? 2 : 1;

  if (flags & 0x04) offset += 2;              // sensor contact status
  if (flags & 0x08) offset += 2;              // energy expended (kJ)

  const rr = [];
  if (flags & 0x10) {
    while (offset + 1 < view.byteLength) {
      rr.push(view.getUint16(offset, true) / 1024 * 1000); // 1/1024s units -> ms
      offset += 2;
    }
  }
  return { heartRate, rr };
}

export async function connectBluetooth() {
  if (!isSupported()) throw new Error('Web Bluetooth is not available in this browser');
  device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [HR_SERVICE] }],
    optionalServices: [HR_SERVICE],
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(HR_SERVICE);
  const char = await service.getCharacteristic(HR_MEASUREMENT);

  await char.startNotifications();
  char.addEventListener('characteristicvaluechanged', (e) => {
    const { heartRate, rr } = parseHeartRateMeasurement(e.target.value);
    rr.forEach(pushRR);
    publish({ heartRate, hrv: computeHRV(rrWindow), source: 'bluetooth', deviceName: device.name });
  });

  device.addEventListener('gattserverdisconnected', () => {
    source = 'none';
    publish({ heartRate: null, hrv: null, source: 'none' });
  });

  source = 'bluetooth';
  return device;
}

function publish(reading) {
  source = reading.source ?? source;
  logBiometric({ heartRate: reading.heartRate, hrv: reading.hrv, source });
  emit({ ...reading, stress: stressScore(reading) });
}

// ---- Simulator ----------------------------------------------------------
// Ornstein-Uhlenbeck style drift around a resting baseline, with occasional
// stress episodes so downstream reactive behaviour is demonstrable.
let simHR = 72;
let simStressUntil = 0;

export function startSimulator({ label = 'Simulator' } = {}) {
  stop();
  source = 'simulator';
  const tick = () => {
    const stressed = Date.now() < simStressUntil;
    const target = stressed ? 104 : 70;
    simHR += (target - simHR) * 0.12 + (Math.random() - 0.5) * 2.4;
    simHR = Math.max(52, Math.min(140, simHR));

    const meanRR = 60000 / simHR;
    const jitter = stressed ? meanRR * 0.02 : meanRR * 0.07;
    const rr = [meanRR + (Math.random() - 0.5) * 2 * jitter, meanRR + (Math.random() - 0.5) * 2 * jitter];
    rr.forEach(pushRR);

    if (!stressed && Math.random() < 0.012) simStressUntil = Date.now() + 20_000;
    publish({ heartRate: Math.round(simHR), hrv: computeHRV(rrWindow), source: 'simulator', deviceName: label });
  };
  tick();
  simTimer = setInterval(tick, 1000);
  return source;
}

export function triggerSimulatedSpike(ms = 25_000) {
  simStressUntil = Date.now() + ms;
}

export function stop() {
  clearInterval(simTimer);
  simTimer = null;
  if (device?.gatt?.connected) device.gatt.disconnect();
  device = null;
  rrWindow = [];
  source = 'none';
  publish({ heartRate: null, hrv: null, source: 'none' });
}

// ---- Reactive behaviour -------------------------------------------------
// Sustained stress nudges the pet's disposition and flags that a calming
// intervention should be offered. The UI layer decides how to present it.
let elevatedSince = null;

export function watchStress(onElevated, onRecovered) {
  return onReading(({ stress, heartRate }) => {
    if (stress == null) return;
    if (stress >= 0.62) {
      if (elevatedSince == null) elevatedSince = Date.now();
      if (Date.now() - elevatedSince > 30_000) {
        nudgePersonality('empathy', 0.01);
        onElevated?.({ stress, heartRate });
        elevatedSince = Date.now();
      }
    } else if (stress < 0.45 && elevatedSince != null) {
      elevatedSince = null;
      nudgePersonality('calm', 0.005);
      onRecovered?.({ stress, heartRate });
    }
  });
}

export function currentReading() {
  const s = getState().biometrics;
  return { heartRate: s.heartRate, hrv: s.hrv, source: s.source, stress: stressScore(s) };
}
