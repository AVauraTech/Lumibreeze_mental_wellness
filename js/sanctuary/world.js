// The sanctuary world: procedural sky, diurnal lighting driven by the player's real
// local clock, weather systems, and per-biome scenery. No external 3D assets are used —
// everything is generated from primitives so the project stays fully offline-capable.

import * as THREE from 'three';
import { BIOMES, biomeById } from '../core/store.js';

const SKY_VERT = /* glsl */`
  varying vec3 vWorldPosition;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPosition = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */`
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uBottom;
  varying vec3 vWorldPosition;
  void main() {
    float h = normalize(vWorldPosition).y;
    vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.62));
    col = mix(uBottom, col, smoothstep(-0.35, 0.03, h));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const PALETTES = {
  day:   { top: new THREE.Color(0x3f8fe0), horizon: new THREE.Color(0xc7e6ff), bottom: new THREE.Color(0xeaf6ff), sun: new THREE.Color(0xfff4d6) },
  dusk:  { top: new THREE.Color(0x2c3a70), horizon: new THREE.Color(0xff9a5c), bottom: new THREE.Color(0x6a4a7a), sun: new THREE.Color(0xffb46b) },
  night: { top: new THREE.Color(0x04060f), horizon: new THREE.Color(0x16233f), bottom: new THREE.Color(0x0a1020), sun: new THREE.Color(0xbfd4ff) },
};

// Biomes whose "sky" is not an atmosphere: space has no daylight cycle, and
// underwater looks up at a lit surface rather than a sun.
const BIOME_SKY = {
  outerspace: { top: 0x060213, horizon: 0x2a1650, bottom: 0x000000, strength: 1.0, stars: 1.0 },
  underwater: { top: 0x9fe4f0, horizon: 0x2f8fa8, bottom: 0x08293c, strength: 0.92, stars: 0.0 },
};

const WEATHERS = ['clear', 'rain', 'storm', 'snow', 'fireflies'];

export class World {
  constructor(scene, { radius = 15 } = {}) {
    this.scene = scene;
    this.radius = radius;
    this.biome = biomeById('meadow');
    this.hour = new Date().getHours() + new Date().getMinutes() / 60;
    this.weather = 'clear';
    this.autoTime = true;
    this.sway = [];
    this.floaters = [];
    this.dayFactor = 1;

    this.buildSky();
    this.buildLights();
    this.buildGround();
    this.buildScenery();
    this.buildWeather();
    this.applyTimeOfDay(this.hour);
  }

  // ---- Sky & lighting ---------------------------------------------------

  buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: PALETTES.day.top.clone() },
        uHorizon: { value: PALETTES.day.horizon.clone() },
        uBottom: { value: PALETTES.day.bottom.clone() },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(220, 32, 20), this.skyMat);
    this.scene.add(this.sky);

    // Star field, faded in only when the sun is below the horizon.
    const starCount = 1400;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(200);
      if (v.y < 4) v.y = Math.abs(v.y) + 4;
      starPos.set([v.x, v.y, v.z], i * 3);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.5, sizeAttenuation: false,
      transparent: true, opacity: 0, depthWrite: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.scene.add(this.stars);

    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(6, 20, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff2c4, fog: false })
    );
    this.moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(4.2, 20, 16),
      new THREE.MeshBasicMaterial({ color: 0xe8f0ff, fog: false })
    );
    this.scene.add(this.sunMesh, this.moonMesh);
  }

  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xc7e6ff, 0x6fbf73, 0.85);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff4d6, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 90;
    const s = 22;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0009;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Soft fill so the pet is never silhouetted at night.
    this.rim = new THREE.PointLight(0x9d7bff, 0, 30);
    this.rim.position.set(0, 4, 0);
    this.scene.add(this.rim);
  }

  // ---- Terrain ----------------------------------------------------------

  buildGround() {
    this.groundGroup = new THREE.Group();
    this.scene.add(this.groundGroup);

    const geo = new THREE.CircleGeometry(this.radius, 96);
    // Gentle undulation so the terrain is not a flat disc.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const d = Math.hypot(x, y);
      if (d > 1.5) pos.setZ(i, Math.sin(x * 0.45) * Math.cos(y * 0.4) * 0.22 * (d / this.radius));
    }
    geo.computeVertexNormals();
    geo.rotateX(-Math.PI / 2);

    this.groundMat = new THREE.MeshStandardMaterial({
      color: this.biome.ground, roughness: 0.96, metalness: 0.0,
    });
    this.ground = new THREE.Mesh(geo, this.groundMat);
    this.ground.receiveShadow = true;
    this.groundGroup.add(this.ground);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(this.radius, 0.18, 12, 96),
      new THREE.MeshStandardMaterial({ color: this.biome.accent, roughness: 0.5, emissive: this.biome.accent, emissiveIntensity: 0.12 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.02;
    this.groundGroup.add(ring);
    this.ring = ring;

    this.scene.fog = new THREE.Fog(this.biome.sky, this.radius * 1.6, this.radius * 9);
  }

  groundHeightAt(x, z) {
    const d = Math.hypot(x, z);
    if (d <= 1.5) return 0;
    return Math.sin(x * 0.45) * Math.cos(z * 0.4) * 0.22 * (d / this.radius);
  }

  // ---- Biome scenery ----------------------------------------------------

  buildScenery() {
    if (this.scenery) {
      this.scene.remove(this.scenery);
      this.scenery.traverse(o => { o.geometry?.dispose?.(); });
    }
    const g = new THREE.Group();
    this.scenery = g;
    this.scene.add(g);
    const R = this.radius;

    const scatter = (n, minR, maxR) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = minR + Math.random() * (maxR - minR);
        out.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
      return out;
    };

    const addTree = (p, scale = 1, foliage = 0x2f7d3a) => {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16 * scale, 0.24 * scale, 1.5 * scale, 8),
        new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 })
      );
      trunk.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + 0.75 * scale);
      trunk.castShadow = true;
      g.add(trunk);
      for (let i = 0; i < 3; i++) {
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry((1.15 - i * 0.26) * scale, (1.3 - i * 0.2) * scale, 9),
          new THREE.MeshStandardMaterial({ color: foliage, roughness: 0.9, flatShading: true })
        );
        cone.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + (1.5 + i * 0.72) * scale);
        cone.castShadow = true;
        g.add(cone);
      }
    };

    const addRock = (p, scale = 1) => {
      const rock = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.55 * scale, 0),
        new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 1, flatShading: true })
      );
      rock.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + 0.22 * scale);
      rock.rotation.set(Math.random(), Math.random(), Math.random());
      rock.scale.y = 0.7;
      rock.castShadow = true;
      g.add(rock);
    };

    const addGrassTuft = (p) => {
      const tuft = new THREE.Mesh(
        new THREE.ConeGeometry(0.14, 0.55, 5),
        new THREE.MeshStandardMaterial({ color: 0x4fa85a, roughness: 1, flatShading: true })
      );
      tuft.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + 0.26);
      tuft.rotation.z = (Math.random() - 0.5) * 0.3;
      g.add(tuft);
      this.sway.push(tuft);
    };

    const addFlower = (p) => {
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 0.4, 5),
        new THREE.MeshStandardMaterial({ color: 0x4fa85a })
      );
      stem.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + 0.2);
      g.add(stem);
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 8, 6),
        new THREE.MeshStandardMaterial({
          color: [0xff8fc7, 0xffe066, 0xff9a5c, 0xc7a7ff][Math.floor(Math.random() * 4)],
          roughness: 0.6, emissive: 0x220011, emissiveIntensity: 0.2,
        })
      );
      head.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + 0.42);
      g.add(head);
      this.sway.push(stem);
    };

    const addMushroom = (p, scale = 1) => {
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14 * scale, 0.2 * scale, 0.6 * scale, 10),
        new THREE.MeshStandardMaterial({ color: 0xfff3e0, roughness: 0.8 })
      );
      stem.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + 0.3 * scale);
      stem.castShadow = true;
      g.add(stem);
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(0.44 * scale, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0xff6fae, roughness: 0.45, emissive: 0xff2f8a, emissiveIntensity: 0.45 })
      );
      cap.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + 0.58 * scale);
      cap.castShadow = true;
      g.add(cap);
    };

    const addGlowOrb = (p) => {
      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xfff0a8, transparent: true, opacity: 0.9 })
      );
      orb.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + 1.2 + Math.random() * 2);
      g.add(orb);
      this.floaters.push({ mesh: orb, base: orb.position.y, phase: Math.random() * 6.28, speed: 0.6 + Math.random() * 0.5 });
    };

    const addKelp = (p) => {
      const h = 1.6 + Math.random() * 2.2;
      const strand = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.17, h, 7),
        new THREE.MeshStandardMaterial({ color: 0x2f9c7a, roughness: 0.7, transparent: true, opacity: 0.9 })
      );
      strand.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + h / 2);
      g.add(strand);
      this.sway.push(strand);
    };

    const addCoral = (p) => {
      const coral = new THREE.Mesh(
        new THREE.TorusKnotGeometry(0.3, 0.1, 40, 6),
        new THREE.MeshStandardMaterial({
          color: [0xff7f7f, 0xffb36b, 0xd98fff][Math.floor(Math.random() * 3)],
          roughness: 0.5, emissive: 0x220022, emissiveIntensity: 0.3,
        })
      );
      coral.position.copy(p).setY(this.groundHeightAt(p.x, p.z) + 0.35);
      coral.rotation.set(Math.random(), Math.random(), Math.random());
      coral.castShadow = true;
      g.add(coral);
    };

    switch (this.biome.id) {
      case 'forest':
        scatter(26, 4, R - 1).forEach(p => addTree(p, 0.8 + Math.random() * 0.7, Math.random() > 0.5 ? 0x2f7d3a : 0x3f8f4a));
        scatter(12, 3, R - 1).forEach(p => addRock(p, 0.6 + Math.random() * 0.9));
        scatter(50, 2.5, R - 1).forEach(addGrassTuft);
        break;
      case 'fairyland':
        scatter(20, 3.5, R - 1).forEach(p => addMushroom(p, 0.7 + Math.random() * 1.1));
        scatter(16, 3, R - 1).forEach(addGlowOrb);
        scatter(40, 2.5, R - 1).forEach(addFlower);
        scatter(8, 4, R - 1).forEach(p => addRock(p, 0.7));
        break;
      case 'outerspace': {
        scatter(22, 5, R - 1).forEach((p) => {
          const rock = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.4 + Math.random() * 0.8, 0),
            new THREE.MeshStandardMaterial({ color: 0x6b6392, roughness: 0.95, flatShading: true, emissive: 0x241a4a, emissiveIntensity: 0.55 })
          );
          rock.position.copy(p).setY(1 + Math.random() * 4);
          rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
          rock.castShadow = true;
          g.add(rock);
          this.floaters.push({ mesh: rock, base: rock.position.y, phase: Math.random() * 6.28, speed: 0.25 + Math.random() * 0.3, spin: true });
        });
        const planet = new THREE.Mesh(
          new THREE.SphereGeometry(3.2, 32, 24),
          new THREE.MeshStandardMaterial({ color: 0x8f6bff, roughness: 0.8, emissive: 0x2a1460, emissiveIntensity: 0.5 })
        );
        planet.position.set(-14, 11, -18);
        g.add(planet);
        const halo = new THREE.Mesh(
          new THREE.TorusGeometry(5, 0.18, 8, 64),
          new THREE.MeshBasicMaterial({ color: 0xd7c4ff, transparent: true, opacity: 0.55 })
        );
        halo.position.copy(planet.position);
        halo.rotation.set(1.2, 0.4, 0);
        g.add(halo);
        break;
      }
      case 'underwater':
        scatter(44, 3, R - 1).forEach(addKelp);
        scatter(16, 3, R - 1).forEach(addCoral);
        scatter(10, 3, R - 1).forEach(p => addRock(p, 0.7));
        break;
      default: // meadow
        scatter(70, 2.5, R - 1).forEach(addGrassTuft);
        scatter(30, 3, R - 1).forEach(addFlower);
        scatter(7, 6, R - 1).forEach(p => addTree(p, 0.85 + Math.random() * 0.4));
        scatter(6, 4, R - 1).forEach(p => addRock(p, 0.6 + Math.random() * 0.6));
    }
  }

  // ---- Weather ----------------------------------------------------------

  buildWeather() {
    this.weatherGroup = new THREE.Group();
    this.scene.add(this.weatherGroup);

    const N = 1600;
    const pos = new Float32Array(N * 3);
    this.rainVel = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 44;
      pos[i * 3 + 1] = Math.random() * 26;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 44;
      this.rainVel[i] = 14 + Math.random() * 10;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.Points(rainGeo, new THREE.PointsMaterial({
      color: 0xa9d4ff, size: 0.16, transparent: true, opacity: 0.8, depthWrite: false,
    }));
    this.rain.visible = false;
    this.rain.frustumCulled = false;
    this.weatherGroup.add(this.rain);

    const sPos = new Float32Array(700 * 3);
    this.snowVel = new Float32Array(700);
    for (let i = 0; i < 700; i++) {
      sPos[i * 3] = (Math.random() - 0.5) * 44;
      sPos[i * 3 + 1] = Math.random() * 26;
      sPos[i * 3 + 2] = (Math.random() - 0.5) * 44;
      this.snowVel[i] = 1.1 + Math.random() * 1.4;
    }
    const snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    this.snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.18, transparent: true, opacity: 0.9, depthWrite: false,
    }));
    this.snow.visible = false;
    this.snow.frustumCulled = false;
    this.weatherGroup.add(this.snow);

    const fPos = new Float32Array(160 * 3);
    this.fireflySeed = [];
    for (let i = 0; i < 160; i++) {
      this.fireflySeed.push({
        r: 2 + Math.random() * (this.radius - 3),
        a: Math.random() * Math.PI * 2,
        y: 0.5 + Math.random() * 3.5,
        speed: 0.15 + Math.random() * 0.4,
        phase: Math.random() * 6.28,
      });
    }
    const flyGeo = new THREE.BufferGeometry();
    flyGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
    this.fireflies = new THREE.Points(flyGeo, new THREE.PointsMaterial({
      color: 0xfff0a0, size: 0.22, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.fireflies.frustumCulled = false;
    this.weatherGroup.add(this.fireflies);

    this.lightning = new THREE.PointLight(0xdfe9ff, 0, 120);
    this.lightning.position.set(6, 22, -8);
    this.scene.add(this.lightning);
    this.nextFlash = 0;
  }

  setWeather(w) {
    if (!WEATHERS.includes(w)) return;
    this.weather = w;
    this.rain.visible = w === 'rain' || w === 'storm';
    this.snow.visible = w === 'snow';
  }

  setBiome(id) {
    this.biome = biomeById(id);
    this.sway = [];
    this.floaters = [];
    this.groundMat.color.set(this.biome.ground);
    this.ring.material.color.set(this.biome.accent);
    this.ring.material.emissive.set(this.biome.accent);
    this.hemi.color.set(this.biome.sky);
    if (this.scene.fog) this.scene.fog.color.set(this.biome.sky);
    this.buildScenery();
  }

  // ---- Time of day ------------------------------------------------------

  setAutoTime(on) { this.autoTime = !!on; }

  setHour(h) {
    this.hour = ((h % 24) + 24) % 24;
    this.applyTimeOfDay(this.hour);
  }

  applyTimeOfDay(hour) {
    // Sunrise ~06:00, solar noon ~13:00, sunset ~20:00.
    const t = (hour - 6) / 14;
    const elevation = Math.sin(t * Math.PI);
    const azimuth = t * Math.PI;

    const dir = new THREE.Vector3(Math.cos(azimuth) * 0.85, elevation, Math.sin(azimuth) * 0.45 - 0.25).normalize();
    const dist = 60;
    this.sun.position.copy(dir).multiplyScalar(dist);
    this.sun.target.position.set(0, 0, 0);

    const day = THREE.MathUtils.smoothstep(elevation, -0.12, 0.3);
    const dusk = Math.max(0, 1 - Math.abs(elevation - 0.16) / 0.5) * (elevation > -0.34 ? 1 : 0);

    const top = PALETTES.night.top.clone().lerp(PALETTES.day.top, day).lerp(PALETTES.dusk.top, dusk * 0.7);
    const horizon = PALETTES.night.horizon.clone().lerp(PALETTES.day.horizon, day).lerp(PALETTES.dusk.horizon, dusk * 0.85);
    const bottom = PALETTES.night.bottom.clone().lerp(PALETTES.day.bottom, day).lerp(PALETTES.dusk.bottom, dusk * 0.6);

    const override = BIOME_SKY[this.biome.id];
    if (override) {
      top.lerp(new THREE.Color(override.top), override.strength);
      horizon.lerp(new THREE.Color(override.horizon), override.strength);
      bottom.lerp(new THREE.Color(override.bottom), override.strength);
    }

    this.skyMat.uniforms.uTop.value.copy(top);
    this.skyMat.uniforms.uHorizon.value.copy(horizon);
    this.skyMat.uniforms.uBottom.value.copy(bottom);

    this.sun.color.copy(PALETTES.night.sun).lerp(PALETTES.day.sun, day).lerp(PALETTES.dusk.sun, dusk * 0.8);
    this.sun.intensity = 0.18 + day * 2.3;
    this.sun.visible = elevation > -0.25;
    this.sunMesh.visible = elevation > -0.12;
    this.sunMesh.position.copy(dir).multiplyScalar(170);
    this.sunMesh.material.color.copy(this.sun.color);

    this.moonMesh.visible = elevation < 0.12;
    this.moonMesh.position.copy(dir).multiplyScalar(-150);

    // Space has no sun to speak of: a cool key light stands in for starlight so
    // scenery never collapses into pure silhouette.
    if (this.biome.id === 'outerspace') {
      this.sun.color.set(0xbfd4ff);
      this.sun.intensity = Math.max(this.sun.intensity, 1.15);
      this.sunMesh.visible = false;
      this.moonMesh.visible = false;
    }

    this.hemi.intensity = (this.biome.id === 'outerspace' ? 0.5 : 0.34) + day * 0.7;
    this.hemi.color.copy(horizon);
    this.hemi.groundColor.set(this.biome.ground);

    const starFloor = override ? override.stars : 0;
    this.starMat.opacity = Math.max(starFloor, Math.max(0, 1 - day * 1.9) * 0.95);
    this.rim.intensity = (1 - day) * 3.0 + (this.biome.id === 'outerspace' ? 1.4 : 0);
    this.rim.color.set(this.biome.accent);

    if (this.scene.fog) {
      this.scene.fog.color.copy(horizon);
      if (this.biome.id === 'underwater') {
        this.scene.fog.near = this.radius * 0.5;
        this.scene.fog.far = this.radius * 3.4;
      } else {
        this.scene.fog.near = this.radius * (1.2 + day * 0.8);
        this.scene.fog.far = this.radius * (5 + day * 6);
      }
    }

    this.dayFactor = day;
    this.sunDirection = dir;
  }

  get isNight() { return (this.dayFactor ?? 1) < 0.25; }

  // ---- Frame update -----------------------------------------------------

  update(dt, elapsed) {
    if (this.autoTime) {
      // 1 real minute = 1 in-game hour by default; slow enough to notice the light move.
      this.hour = (this.hour + dt / 60) % 24;
      this.applyTimeOfDay(this.hour);
    }

    for (const m of this.sway) {
      m.rotation.z = Math.sin(elapsed * 1.6 + m.position.x * 0.6) * 0.09;
    }
    for (const f of this.floaters) {
      f.mesh.position.y = f.base + Math.sin(elapsed * f.speed + f.phase) * 0.35;
      if (f.spin) f.mesh.rotation.y += dt * 0.25;
    }

    const rp = this.rain.geometry.attributes.position;
    if (this.rain.visible) {
      for (let i = 0; i < this.rainVel.length; i++) {
        let y = rp.getY(i) - this.rainVel[i] * dt;
        if (y < 0) { y = 24 + Math.random() * 4; rp.setX(i, (Math.random() - 0.5) * 44); rp.setZ(i, (Math.random() - 0.5) * 44); }
        rp.setY(i, y);
      }
      rp.needsUpdate = true;
    }

    const sp = this.snow.geometry.attributes.position;
    if (this.snow.visible) {
      for (let i = 0; i < this.snowVel.length; i++) {
        let y = sp.getY(i) - this.snowVel[i] * dt;
        sp.setX(i, sp.getX(i) + Math.sin(elapsed * 0.8 + i) * dt * 0.5);
        if (y < 0) { y = 24 + Math.random() * 4; sp.setX(i, (Math.random() - 0.5) * 44); sp.setZ(i, (Math.random() - 0.5) * 44); }
        sp.setY(i, y);
      }
      sp.needsUpdate = true;
    }

    const fp = this.fireflies.geometry.attributes.position;
    const wantFlies = this.isNight || this.biome.id === 'fairyland';
    const targetOpacity = wantFlies ? 0.9 : 0;
    this.fireflies.material.opacity += (targetOpacity - this.fireflies.material.opacity) * Math.min(1, dt * 1.5);
    if (this.fireflies.material.opacity > 0.01) {
      for (let i = 0; i < this.fireflySeed.length; i++) {
        const s = this.fireflySeed[i];
        const a = s.a + elapsed * s.speed;
        fp.setXYZ(i, Math.cos(a) * s.r, s.y + Math.sin(elapsed * 1.3 + s.phase) * 0.5, Math.sin(a) * s.r);
      }
      fp.needsUpdate = true;
    }

    if (this.weather === 'storm') {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.lightning.intensity = 260;
        this.nextFlash = 2.5 + Math.random() * 5;
      }
      this.lightning.intensity *= Math.pow(0.0015, dt);
    } else {
      this.lightning.intensity = 0;
    }
  }

  static get BIOMES() { return BIOMES; }
  static get WEATHERS() { return WEATHERS; }
}
