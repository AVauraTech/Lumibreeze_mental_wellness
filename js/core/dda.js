// Dynamic Difficulty Adjustment for Jungle-Jumble.
// Watches accuracy, reaction latency, and pointer jitter, then retunes the board so
// the game stays in the player's flow channel instead of frustrating or boring them.

import { getState, setState } from './store.js';

export const TIERS = [
  { tier: 0, rows: 3, cols: 4, pairs: 6,  revealMs: 1500, label: 'Gentle' },
  { tier: 1, rows: 4, cols: 4, pairs: 8,  revealMs: 1250, label: 'Easy' },
  { tier: 2, rows: 4, cols: 5, pairs: 10, revealMs: 1050, label: 'Steady' },
  { tier: 3, rows: 4, cols: 6, pairs: 12, revealMs: 900,  label: 'Focused' },
  { tier: 4, rows: 5, cols: 6, pairs: 15, revealMs: 780,  label: 'Sharp' },
  { tier: 5, rows: 6, cols: 6, pairs: 18, revealMs: 650,  label: 'Intense' },
];

const MIN_TIER = 0;
const MAX_TIER = 5;

export class DDAMonitor {
  constructor({ onAdjust, onMindfulMoment, getExternalStress = () => null } = {}) {
    this.onAdjust = onAdjust;
    this.onMindfulMoment = onMindfulMoment;
    this.getExternalStress = getExternalStress;
    this.reset();
  }

  reset() {
    this.tier = this.clampTier(getState().dda.level);
    this.attempts = 0;
    this.matches = 0;
    this.latencies = [];
    this.firstFlipAt = null;
    this.consecutiveMisses = 0;
    this.pointerSamples = [];
    this.jitter = 0;
    this.lastBreakAt = Date.now();
    this.startedAt = Date.now();
    this.stressPeak = 0;
  }

  clampTier(t) { return Math.min(MAX_TIER, Math.max(MIN_TIER, Math.round(t) || 0)); }

  get config() { return TIERS[this.tier]; }

  // ---- Signals ----------------------------------------------------------

  noteFirstFlip() { this.firstFlipAt = performance.now(); }

  noteAttempt(matched) {
    this.attempts++;
    if (this.firstFlipAt != null) {
      this.latencies.push(performance.now() - this.firstFlipAt);
      if (this.latencies.length > 12) this.latencies.shift();
      this.firstFlipAt = null;
    }
    if (matched) { this.matches++; this.consecutiveMisses = 0; }
    else this.consecutiveMisses++;
    this.evaluateStress();
  }

  notePointer(x, y, t = performance.now()) {
    const prev = this.pointerSamples[this.pointerSamples.length - 1];
    this.pointerSamples.push({ x, y, t });
    if (this.pointerSamples.length > 40) this.pointerSamples.shift();
    if (!prev) return;
    const dt = Math.max(1, t - prev.t);
    const speed = Math.hypot(x - prev.x, y - prev.y) / dt; // px per ms
    // Jitter = variance in speed. Thrashing the mouse reads as agitation.
    const speeds = this.pointerSamples.map((s, i, a) =>
      i === 0 ? 0 : Math.hypot(s.x - a[i - 1].x, s.y - a[i - 1].y) / Math.max(1, s.t - a[i - 1].t));
    const mean = speeds.reduce((a, b) => a + b, 0) / (speeds.length || 1);
    const variance = speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / (speeds.length || 1);
    this.jitter = 0.85 * this.jitter + 0.15 * Math.min(1, Math.sqrt(variance) / 1.6);
    return speed;
  }

  get accuracy() { return this.attempts ? this.matches / this.attempts : 0; }

  get avgLatency() {
    return this.latencies.length
      ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
      : 0;
  }

  // Blended 0..1 stress: gameplay frustration signals plus any biometric feed.
  get stress() {
    const missPressure = Math.min(1, this.consecutiveMisses / 4);
    const accuracyPressure = this.attempts >= 4 ? Math.min(1, 1 - this.accuracy / 0.5) : 0;
    const latencyPressure = this.avgLatency ? Math.min(1, this.avgLatency / 6000) : 0;
    const external = this.getExternalStress();
    const gameplay = Math.max(0, Math.min(1, 0.45 * missPressure + 0.3 * accuracyPressure + 0.25 * latencyPressure + 0.35 * this.jitter));
    const blended = external == null ? gameplay : 0.6 * gameplay + 0.4 * external;
    this.stressPeak = Math.max(this.stressPeak * 0.995, blended);
    return Math.round(blended * 100) / 100;
  }

  // ---- Adaptation -------------------------------------------------------

  evaluateStress() {
    if (this.attempts < 3) return;
    const before = this.tier;
    const acc = this.accuracy;
    const stress = this.stress;

    // Doing well and calm -> raise the challenge.
    if (acc >= 0.62 && stress < 0.45 && this.avgLatency < 4200) this.tier = this.clampTier(this.tier + 1);
    // Struggling, or visibly stressed -> ease off.
    else if (acc < 0.38 || this.consecutiveMisses >= 3 || stress > 0.7) this.tier = this.clampTier(this.tier - 1);

    const changed = this.tier !== before;
    this.persist();

    if (stress > 0.72 && Date.now() - this.lastBreakAt > 90_000) {
      this.lastBreakAt = Date.now();
      this.onMindfulMoment?.({ stress, reason: this.consecutiveMisses >= 3 ? 'misses' : 'stress' });
    } else if (changed) {
      this.onAdjust?.(this.config, { accuracy: acc, stress, direction: this.tier > before ? 'up' : 'down' });
    }
  }

  persist() {
    setState(s => {
      s.dda.level = this.tier;
      s.dda.games = (s.dda.games || 0);
      s.dda.accuracy = Math.round(this.accuracy * 100) / 100;
      s.dda.avgLatency = Math.round(this.avgLatency);
      s.dda.stress = this.stress;
    }, 'dda');
  }

  finishSession(won) {
    this.persist();
    setState(s => {
      s.dda.games = (s.dda.games || 0) + 1;
      if (won) s.dda.wins = (s.dda.wins || 0) + 1;
    }, 'dda');
  }

  // Extra reveal time on mismatches when the player is stressed — a forgiving
  // pacing tweak that does not change the board itself.
  get revealMs() {
    const base = this.config.revealMs;
    return Math.round(base * (1 + this.stress * 0.7));
  }
}

export const MINDFUL_PROMPTS = [
  { text: 'Pause with me — inhale for 4, hold for 3, exhale for 5.', seconds: 12 },
  { text: 'Look away from the screen. Name 5 things you can see right now.', seconds: 10 },
  { text: 'Drop your shoulders, unclench your jaw, take one slow breath.', seconds: 8 },
  { text: 'Rest your eyes for a moment. The cards will wait.', seconds: 10 },
];
