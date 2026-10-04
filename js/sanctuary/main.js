// Sanctuary bootstrap: renderer, camera rig, input, HUD, and the bridge between
// the 3D world and the shared store / biometric feed.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { World } from './world.js';
import { LumiPet3D, Toy } from './pet.js';
import { ParticleDirector } from './particles.js';
import {
  ready, getState, setState, subscribe, gainXP, recordHabit,
  stageName, biomeById, BIOMES,
} from '../core/store.js';
import { sfx, setEnabled, ambience } from '../core/audio.js';
import {
  connectBluetooth, startSimulator, stop, onReading, watchStress,
  isSupported as btSupported, triggerSimulatedSpike, currentReading,
} from '../core/biometrics.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

let renderer, scene, camera, controls, world, pet, toy, particles;
let raycaster, pointer, clock;
let stopAmbience = () => {};
let chasing = false;
let breathingActive = false;

async function boot() {
  await ready;
  const state = getState();

  const canvas = $('scene');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: state.settings.quality === 'high', powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, state.settings.quality === 'high' ? 2 : 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(46, 1, 0.1, 600);
  camera.position.set(9.5, 7.5, 12.5);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 5;
  controls.maxDistance = 34;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.target.set(0, 1.3, 0);

  world = new World(scene, { radius: 15 });
  world.setBiome(state.pet.biome);

  pet = new LumiPet3D(scene, { groundHeight: (x, z) => world.groundHeightAt(x, z) });
  pet.setStage(state.pet.stage);
  if (state.pet.name) document.title = `${state.pet.name} · Lumi Sanctuary`;

  toy = new Toy(scene, { groundHeight: (x, z) => world.groundHeightAt(x, z) });
  particles = new ParticleDirector(scene);

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  clock = new THREE.Clock();

  resize();
  window.addEventListener('resize', resize);
  bindInput();
  bindHUD();
  bindBiometrics();
  bindStore();

  syncMoodFromState();
  setEnabled(state.settings.sound);
  startAmbienceFor(biomeById(state.pet.biome).id);

  renderer.setAnimationLoop(frame);
  window.__sanctuary = { renderer, scene, camera, controls, world, pet, toy, particles };
  notice('🌿 Welcome to the sanctuary. Click Lumi to pet, click the ground to throw the ball.');
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  const elapsed = clock.elapsedTime;

  if (chasing) {
    pet.setTarget(toy.mesh.position);
    if (toy.atRest && pet.position.distanceTo(toy.mesh.position) < 1.1) {
      chasing = false;
      pet.react('play');
      particles.emit('heart', pet.position.clone().add(new THREE.Vector3(0, 1.7, 0)), 12);
      sfx.match();
      applyStat('happiness', 7);
      gainXP(3);
    }
  }
  if (!pet.target && !chasing && Math.random() < dt * 0.13 && pet.mood !== 'sleeping') {
    pet.wanderWithin(12);
  }

  toy.update(dt);
  pet.update(dt, elapsed);
  particles.update(dt);
  world.update(dt, elapsed);
  controls.update();
  renderer.render(scene, camera);
}

// ---- Interaction --------------------------------------------------------

function bindInput() {
  let downAt = 0, downPos = { x: 0, y: 0 };

  renderer.domElement.addEventListener('pointerdown', (e) => {
    downAt = performance.now();
    downPos = { x: e.clientX, y: e.clientY };
  });

  renderer.domElement.addEventListener('pointerup', (e) => {
    // Ignore drags — those are camera orbits, not clicks.
    if (performance.now() - downAt > 320) return;
    if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 7) return;

    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hitPet = raycaster.intersectObject(pet.group, true);
    if (hitPet.length) { petLumi(); return; }

    const hitGround = raycaster.intersectObject(world.ground, false);
    if (hitGround.length) {
      toy.throwTo(hitGround[0].point);
      chasing = true;
      sfx.flip();
    }
  });
}

function petLumi() {
  pet.react('pet');
  particles.emit('heart', pet.position.clone().add(new THREE.Vector3(0, 1.8, 0)), 14);
  sfx.bubble();
  applyStat('happiness', 3);
  setState(s => { s.pet.personality.playfulness = clamp(s.pet.personality.playfulness + 0.004, 0, 1); }, 'pet');
}

// ---- Store bridge -------------------------------------------------------

function applyStat(stat, delta) {
  setState(s => { s.pet[stat] = clamp(s.pet[stat] + delta); }, 'action');
}

function syncMoodFromState() {
  const s = getState();
  if (s.pet.energy < 18) { pet.setMood('sleeping'); return; }
  const wellbeing = (s.pet.happiness + s.pet.hunger + s.pet.energy + s.pet.health) / 4;
  const stress = currentReading().stress;
  if (stress != null && stress >= 0.62) pet.setMood('restless');
  else if (wellbeing >= 68) pet.setMood('happy');
  else if (wellbeing < 38) pet.setMood('sad');
  else pet.setMood('neutral');
}

function bindStore() {
  let lastStage = getState().pet.stage;
  subscribe(() => {
    const s = getState();
    renderHUD();
    if (s.pet.stage !== lastStage) {
      lastStage = s.pet.stage;
      pet.setStage(s.pet.stage);
      pet.react('evolve');
      particles.emit('star', pet.position.clone().add(new THREE.Vector3(0, 2.2, 0)), 34);
      sfx.evolve();
      notice(`✨ Lumi evolved into ${stageName()}!`);
    }
    syncMoodFromState();
  });
  renderHUD();
}

const ACTIONS = {
  feed: () => {
    const s = getState();
    if (s.economy.coins < 5) return notice('Not enough coins to feed Lumi.');
    setState(x => { x.economy.coins -= 5; }, 'action');
    applyStat('hunger', 25);
    applyStat('cleanliness', -4);
    pet.react('feed');
    particles.emit('sparkle', pet.position.clone().add(new THREE.Vector3(0, 1.5, 0)), 10);
    sfx.coin();
    gainXP(10);
    notice('🍖 Lumi ate happily. +10 XP');
  },
  water: () => {
    const s = getState();
    if (s.economy.coins < 3) return notice('Not enough coins for water.');
    setState(x => { x.economy.coins -= 3; }, 'action');
    applyStat('thirst', 30);
    pet.react('water');
    particles.emit('droplet', pet.position.clone().add(new THREE.Vector3(0, 1.5, 0)), 12);
    sfx.bubble();
    gainXP(8);
    notice('💧 Refreshing! +8 XP');
  },
  play: () => {
    applyStat('happiness', 14);
    applyStat('energy', -10);
    toy.throwTo(new THREE.Vector3((Math.random() - 0.5) * 16, 0, (Math.random() - 0.5) * 16));
    chasing = true;
    pet.react('play');
    sfx.flip();
    gainXP(12);
    notice('🎾 Go get it, Lumi! +12 XP');
  },
  sleep: () => {
    applyStat('energy', 40);
    applyStat('happiness', 10);
    pet.setMood('sleeping');
    particles.emit('zzz', pet.position.clone().add(new THREE.Vector3(0, 2.1, 0)), 6);
    sfx.breathOut();
    gainXP(15);
    setTimeout(() => syncMoodFromState(), 6000);
    notice('🛌 Lumi is resting. +15 XP');
  },
  bath: () => {
    const s = getState();
    if (s.economy.coins < 7) return notice('Not enough coins for a bath.');
    setState(x => { x.economy.coins -= 7; }, 'action');
    setState(x => { x.pet.cleanliness = 100; }, 'action');
    pet.react('bath');
    particles.emit('droplet', pet.position.clone().add(new THREE.Vector3(0, 1.6, 0)), 26);
    sfx.bubble();
    gainXP(12);
    notice('🛁 Sparkly clean! +12 XP');
  },
  habit: () => {
    const kept = recordHabit('Sanctuary check-in');
    pet.react('pet');
    particles.emit('sparkle', pet.position.clone().add(new THREE.Vector3(0, 1.9, 0)), 20);
    sfx.levelUp();
    notice(kept ? `✅ Check-in logged — streak ${getState().streak.count} day(s). +10 XP` : '✅ Already checked in today — streak preserved.');
  },
};

// ---- HUD ----------------------------------------------------------------

function bindHUD() {
  for (const [key, fn] of Object.entries(ACTIONS)) {
    const btn = $(`act-${key}`);
    if (btn) btn.addEventListener('click', fn);
  }

  const biomeSel = $('biome-select');
  biomeSel.innerHTML = BIOMES.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  biomeSel.value = getState().pet.biome;
  biomeSel.addEventListener('change', () => {
    setState(s => { s.pet.biome = biomeSel.value; }, 'biome');
    world.setBiome(biomeSel.value);
    startAmbienceFor(biomeSel.value);
    notice(`🏡 Moved to ${biomeById(biomeSel.value).name}.`);
  });

  const weatherSel = $('weather-select');
  weatherSel.innerHTML = World.WEATHERS.map(w => `<option value="${w}">${w[0].toUpperCase() + w.slice(1)}</option>`).join('');
  weatherSel.addEventListener('change', () => world.setWeather(weatherSel.value));

  const timeSlider = $('time-slider');
  const timeLabel = $('time-label');
  const autoTime = $('auto-time');
  autoTime.checked = true;
  timeSlider.disabled = true;

  const fmt = (h) => {
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh + 11) % 12) + 1;
    return `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
  };

  autoTime.addEventListener('change', () => {
    world.setAutoTime(autoTime.checked);
    timeSlider.disabled = autoTime.checked;
  });
  timeSlider.addEventListener('input', () => {
    world.setAutoTime(false);
    autoTime.checked = false;
    world.setHour(parseFloat(timeSlider.value));
    timeLabel.textContent = fmt(world.hour);
  });
  timeLabel.textContent = fmt(world.hour);
  setInterval(() => { if (world.autoTime) timeLabel.textContent = fmt(world.hour); }, 1000);

  $('quality-select').value = getState().settings.quality;
  $('quality-select').addEventListener('change', (e) => {
    setState(s => { s.settings.quality = e.target.value; }, 'settings');
    const high = e.target.value === 'high';
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, high ? 2 : 1.25));
    renderer.shadowMap.enabled = high;
    world.sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
    world.sun.shadow.map?.dispose();
    world.sun.shadow.map = null;
  });

  $('sound-toggle').addEventListener('click', () => {
    const next = !getState().settings.sound;
    setState(s => { s.settings.sound = next; }, 'settings');
    setEnabled(next);
    $('sound-toggle').textContent = next ? '🔊' : '🔇';
  });
  $('sound-toggle').textContent = getState().settings.sound ? '🔊' : '🔇';

  $('name-input').value = getState().pet.name;
  $('name-input').addEventListener('change', (e) => {
    setState(s => { s.pet.name = e.target.value.trim(); }, 'name');
    notice('💜 Name updated.');
  });

  $('breath-start').addEventListener('click', openBreathingQuest);
  $('breath-close').addEventListener('click', closeBreathing);
}

const STAT_META = [
  ['hunger', 'Hunger'], ['thirst', 'Thirst'], ['happiness', 'Happiness'],
  ['energy', 'Energy'], ['cleanliness', 'Cleanliness'], ['health', 'Health'],
];

function renderHUD() {
  const s = getState();
  for (const [key, label] of STAT_META) {
    const fill = $(`bar-${key}`);
    const val = $(`val-${key}`);
    if (!fill) continue;
    const v = Math.round(s.pet[key]);
    fill.style.width = v + '%';
    fill.className = 'fill ' + (v < 25 ? 'low' : v < 55 ? 'mid' : 'high');
    if (val) val.textContent = v;
  }
  $('hud-stage').textContent = stageName();
  $('hud-xp').textContent = `${s.pet.xp} / 100 XP`;
  $('xp-fill').style.width = (s.pet.xp % 100) + '%';
  $('hud-coins').textContent = s.economy.coins;
  $('hud-gems').textContent = s.economy.gems;
  $('hud-streak').textContent = s.streak.count;
  $('hud-name').textContent = s.pet.name || 'Lumi';

  const p = s.pet.personality;
  $('trait-empathy').style.width = Math.round(p.empathy * 100) + '%';
  $('trait-play').style.width = Math.round(p.playfulness * 100) + '%';
  $('trait-calm').style.width = Math.round(p.calm * 100) + '%';
}

// ---- Biometrics ---------------------------------------------------------

function bindBiometrics() {
  const btBtn = $('bio-bluetooth');
  const simBtn = $('bio-sim');
  const offBtn = $('bio-off');
  const spikeBtn = $('bio-spike');

  btBtn.disabled = !btSupported();
  btBtn.title = btSupported() ? 'Pair a heart-rate strap or watch' : 'Web Bluetooth unavailable in this browser';

  btBtn.addEventListener('click', async () => {
    try {
      await connectBluetooth();
      notice(`💓 Paired with ${getState().biometrics.source === 'bluetooth' ? 'device' : 'sensor'}.`);
    } catch (err) {
      notice(`⚠️ Bluetooth pairing cancelled or unsupported: ${err.message}`);
    }
  });

  simBtn.addEventListener('click', () => {
    startSimulator();
    notice('🧪 Biometric simulator running — HR and HRV are synthetic, not real measurements.');
  });

  spikeBtn.addEventListener('click', () => {
    if (getState().biometrics.source !== 'simulator') return notice('Start the simulator first.');
    triggerSimulatedSpike(30_000);
    notice('📈 Simulated stress spike injected for 30s.');
  });

  offBtn.addEventListener('click', () => {
    stop();
    notice('Biometric feed disconnected.');
  });

  onReading(({ heartRate, hrv, stress, source }) => {
    $('bio-hr').textContent = heartRate == null ? '—' : `${heartRate} bpm`;
    $('bio-hrv').textContent = hrv == null ? '—' : `${Math.round(hrv)} ms`;
    $('bio-source').textContent = source === 'bluetooth' ? 'Bluetooth' : source === 'simulator' ? 'Simulator' : 'Off';
    if (stress == null) {
      $('bio-stress-fill').style.width = '0%';
      $('bio-stress-text').textContent = '—';
    } else {
      const pct = Math.round(stress * 100);
      $('bio-stress-fill').style.width = pct + '%';
      $('bio-stress-fill').className = 'fill ' + (pct > 62 ? 'low' : pct > 40 ? 'mid' : 'high');
      $('bio-stress-text').textContent = `${pct}%`;
    }
  });

  watchStress(
    ({ stress, heartRate }) => {
      pet.setMood('restless');
      notice(`💓 Elevated stress detected (${Math.round(stress * 100)}%, ${heartRate} bpm). Lumi is getting restless.`);
      if (!breathingActive) openBreathingQuest();
    },
    () => {
      syncMoodFromState();
      notice('🌿 Your readings have settled. Nice work.');
    }
  );
}

// ---- Synchronized breathing quest ---------------------------------------

let breathTimer = null;
function openBreathingQuest() {
  if (breathingActive) return;
  breathingActive = true;
  const overlay = $('breath-overlay');
  const orb = $('breath-orb');
  const label = $('breath-label');
  overlay.classList.add('show');

  // 4-3-5 pacing, matching the guided exercise used elsewhere in the app.
  const phases = [
    { name: 'Breathe in', seconds: 4, cls: 'in' },
    { name: 'Hold', seconds: 3, cls: 'hold' },
    { name: 'Breathe out', seconds: 5, cls: 'out' },
  ];
  let cycle = 0, phaseIdx = 0, remaining = phases[0].seconds;

  const paint = () => {
    const p = phases[phaseIdx];
    label.textContent = `${p.name} · ${remaining}s`;
    orb.className = 'breath-orb ' + p.cls;
  };
  paint();
  sfx.breathIn();

  breathTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      phaseIdx++;
      if (phaseIdx >= phases.length) {
        phaseIdx = 0;
        cycle++;
      }
      remaining = phases[phaseIdx].seconds;
      if (phases[phaseIdx].name === 'Breathe in') sfx.breathIn();
      if (phases[phaseIdx].name === 'Breathe out') sfx.breathOut();
    }
    paint();
    if (cycle >= 3) finishBreathing(true);
  }, 1000);
}

function finishBreathing(completed) {
  clearInterval(breathTimer);
  breathTimer = null;
  closeBreathing();
  if (!completed) return;
  applyStat('happiness', 8);
  applyStat('energy', 6);
  setState(s => { s.pet.personality.calm = clamp(s.pet.personality.calm + 0.02, 0, 1); }, 'breath');
  gainXP(20);
  pet.react('pet');
  particles.emit('sparkle', pet.position.clone().add(new THREE.Vector3(0, 1.8, 0)), 22);
  sfx.levelUp();
  notice('🧘 Three cycles complete. +20 XP — Lumi feels calmer too.');
}

function closeBreathing() {
  clearInterval(breathTimer);
  breathTimer = null;
  breathingActive = false;
  $('breath-overlay').classList.remove('show');
}

// ---- Ambience -----------------------------------------------------------

function startAmbienceFor(biomeId) {
  stopAmbience();
  if (getState().settings.sound) stopAmbience = ambience(biomeId);
}

// ---- Toast --------------------------------------------------------------

let noticeTimer = null;
function notice(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('fatal');
  if (el) {
    el.hidden = false;
    el.textContent = `Sanctuary failed to start: ${err.message}. WebGL support and a local http:// server are required.`;
  }
});
