// Procedural LumiPet built entirely from primitives — no external 3D assets.
// The body mesh is deformed per-frame so Lumi reads as a soft, breathing blob rather
// than a rigid statue, and mood drives posture, ear angle, colour and movement speed.

import * as THREE from 'three';

const MOODS = {
  happy:    { earLift: 0.5,  headTilt: 0.12, speed: 1.35, desaturate: 0.0,  bob: 1.5, breath: 1.15 },
  neutral:  { earLift: 0.1,  headTilt: 0.0,  speed: 1.0,  desaturate: 0.0,  bob: 1.0, breath: 1.0 },
  sad:      { earLift: -0.7, headTilt: -0.3, speed: 0.55, desaturate: 0.45, bob: 0.5, breath: 0.7 },
  restless: { earLift: 0.35, headTilt: 0.05, speed: 1.9,  desaturate: 0.1,  bob: 2.2, breath: 1.9 },
  sleeping: { earLift: -0.5, headTilt: -0.45, speed: 0.0, desaturate: 0.2,  bob: 0.3, breath: 0.45 },
};

const STAGE_SCALE = [0.72, 0.86, 1.0, 1.12, 1.26];

export class LumiPet3D {
  constructor(scene, { groundHeight = () => 0 } = {}) {
    this.scene = scene;
    this.groundHeight = groundHeight;
    this.stage = 0;
    this.mood = 'neutral';
    this.baseColor = new THREE.Color(0xa678f7);
    this.bellyColor = new THREE.Color(0xe8dcff);

    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.body);
    scene.add(this.group);

    this.velocity = new THREE.Vector3();
    this.target = null;
    this.hopTime = -1;
    this.blinkAt = 2 + Math.random() * 3;
    this.blinkT = -1;
    this.emissivePulse = 0;

    this.build();
    this.setStage(0);
    this.applyMood();
  }

  build() {
    const skin = new THREE.MeshStandardMaterial({ color: this.baseColor, roughness: 0.52, metalness: 0.02 });
    const belly = new THREE.MeshStandardMaterial({ color: this.bellyColor, roughness: 0.62 });
    this.skinMat = skin;
    this.bellyMat = belly;

    // Blobby torso — deformed every frame in update().
    const torsoGeo = new THREE.SphereGeometry(0.82, 28, 20);
    this.torsoBase = Float32Array.from(torsoGeo.attributes.position.array);
    this.torso = new THREE.Mesh(torsoGeo, skin);
    this.torso.scale.set(1, 0.94, 0.96);
    this.torso.position.y = 0.86;
    this.torso.castShadow = true;
    this.body.add(this.torso);

    const bellyMesh = new THREE.Mesh(new THREE.SphereGeometry(0.58, 20, 16), belly);
    bellyMesh.scale.set(0.9, 1.0, 0.5);
    bellyMesh.position.set(0, 0.78, 0.42);
    this.body.add(bellyMesh);

    // Head
    this.head = new THREE.Group();
    this.head.position.y = 1.62;
    this.body.add(this.head);

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 18), skin);
    skull.scale.set(1, 0.92, 0.95);
    skull.castShadow = true;
    this.head.add(skull);

    this.ears = [];
    for (const side of [-1, 1]) {
      const earPivot = new THREE.Group();
      earPivot.position.set(side * 0.36, 0.4, 0);
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 12), skin);
      ear.scale.set(0.62, 1.5, 0.5);
      ear.position.y = 0.22;
      ear.castShadow = true;
      const inner = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), belly);
      inner.scale.set(0.5, 1.3, 0.4);
      inner.position.set(0, 0.24, 0.06);
      earPivot.add(ear, inner);
      earPivot.rotation.z = side * 0.3;
      this.head.add(earPivot);
      this.ears.push({ pivot: earPivot, side });
    }

    // Eyes
    this.eyes = [];
    const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x2a1340, roughness: 0.15 });
    const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const side of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(side * 0.21, 0.06, 0.5);
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 12), eyeWhiteMat);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), pupilMat);
      pupil.position.z = 0.075;
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 6), glintMat);
      glint.position.set(0.035, 0.04, 0.13);
      const lid = new THREE.Mesh(
        new THREE.SphereGeometry(0.145, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        skin
      );
      lid.rotation.x = Math.PI;
      lid.position.y = 0.02;
      lid.visible = false;
      eye.add(white, pupil, glint, lid);
      this.head.add(eye);
      this.eyes.push({ group: eye, pupil, lid });
    }

    // Cheeks + mouth
    const cheekMat = new THREE.MeshStandardMaterial({ color: 0xff9ec4, roughness: 0.6, transparent: true, opacity: 0.75 });
    for (const side of [-1, 1]) {
      const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), cheekMat);
      cheek.scale.set(1, 0.7, 0.4);
      cheek.position.set(side * 0.36, -0.1, 0.44);
      this.head.add(cheek);
    }
    this.mouth = new THREE.Mesh(
      new THREE.TorusGeometry(0.09, 0.022, 8, 16, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x4a2160, roughness: 0.5 })
    );
    this.mouth.position.set(0, -0.16, 0.53);
    this.mouth.rotation.x = Math.PI;
    this.head.add(this.mouth);

    // Limbs
    this.arms = [];
    for (const side of [-1, 1]) {
      const armPivot = new THREE.Group();
      armPivot.position.set(side * 0.74, 1.0, 0);
      const arm = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 12), skin);
      arm.scale.set(0.8, 1.15, 0.8);
      arm.position.y = -0.16;
      arm.castShadow = true;
      armPivot.add(arm);
      armPivot.rotation.z = side * 0.35;
      this.body.add(armPivot);
      this.arms.push({ pivot: armPivot, side });
    }
    for (const side of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 12), skin);
      foot.scale.set(1, 0.62, 1.25);
      foot.position.set(side * 0.33, 0.16, 0.12);
      foot.castShadow = true;
      this.body.add(foot);
    }

    // Tail
    this.tailPivot = new THREE.Group();
    this.tailPivot.position.set(0, 0.7, -0.78);
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12), skin);
    tail.scale.set(0.85, 0.85, 1.1);
    tail.position.z = -0.16;
    tail.castShadow = true;
    this.tailPivot.add(tail);
    this.body.add(this.tailPivot);

    // Ground shadow catcher that follows Lumi across uneven terrain.
    this.contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })
    );
    this.contactShadow.rotation.x = -Math.PI / 2;
    this.contactShadow.position.y = 0.03;
    this.group.add(this.contactShadow);

    // Stage extras
    this.crown = new THREE.Mesh(
      new THREE.ConeGeometry(0.34, 0.42, 5),
      new THREE.MeshStandardMaterial({ color: 0xffd76b, roughness: 0.25, metalness: 0.85, emissive: 0x5a3d00, emissiveIntensity: 0.5 })
    );
    this.crown.position.y = 0.62;
    this.crown.visible = false;
    this.head.add(this.crown);

    this.horn = new THREE.Mesh(
      new THREE.ConeGeometry(0.1, 0.34, 8),
      new THREE.MeshStandardMaterial({ color: 0xfff0a8, roughness: 0.3, emissive: 0x6b5a00, emissiveIntensity: 0.6 })
    );
    this.horn.position.set(0, 0.56, 0.1);
    this.horn.visible = false;
    this.head.add(this.horn);

    this.wings = new THREE.Group();
    const wingMat = new THREE.MeshStandardMaterial({
      color: 0xd7c4ff, roughness: 0.35, transparent: true, opacity: 0.72,
      side: THREE.DoubleSide, emissive: 0x6b4ac0, emissiveIntensity: 0.4,
    });
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.CircleGeometry(0.62, 20, 0, Math.PI * 1.15), wingMat);
      wing.scale.set(0.75, 1.2, 1);
      wing.position.set(side * 0.55, 1.25, -0.5);
      wing.rotation.set(0.35, side * 0.7, side * 0.5);
      this.wings.add(wing);
    }
    this.wings.visible = false;
    this.body.add(this.wings);

    this.aura = new THREE.Mesh(
      new THREE.TorusGeometry(1.25, 0.05, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0 })
    );
    this.aura.rotation.x = Math.PI / 2;
    this.aura.position.y = 0.15;
    this.group.add(this.aura);
  }

  setStage(n) {
    this.stage = Math.max(0, Math.min(4, n));
    const s = STAGE_SCALE[this.stage];
    this.group.scale.setScalar(s);
    this.crown.visible = this.stage >= 4;
    this.horn.visible = this.stage === 2 || this.stage === 3;
    this.wings.visible = this.stage >= 3;
    this.aura.material.opacity = this.stage >= 4 ? 0.55 : this.stage >= 3 ? 0.3 : 0;
  }

  setColor(hex) {
    this.baseColor.set(hex);
    this.applyMood();
  }

  setMood(mood) {
    if (!(mood in MOODS)) return;
    this.mood = mood;
    this.applyMood();
  }

  applyMood() {
    const m = MOODS[this.mood];
    const c = this.baseColor.clone();
    if (m.desaturate > 0) {
      const grey = new THREE.Color(c.r * 0.3 + c.g * 0.59 + c.b * 0.11);
      c.lerp(grey, m.desaturate);
    }
    this.skinMat.color.copy(c);
    this.mouth.scale.set(1, this.mood === 'sad' ? -1 : 1, 1);
  }

  react(kind) {
    if (kind === 'evolve') {
      this.hopTime = 0;
      this.hopPower = 2.4;
      this.emissivePulse = 1;
    } else if (kind === 'pet' || kind === 'play') {
      this.hopTime = 0;
      this.hopPower = 1.1;
    } else if (kind === 'feed' || kind === 'water' || kind === 'bath') {
      this.emissivePulse = 0.55;
    } else if (kind === 'sleep') {
      this.setMood('sleeping');
    }
  }

  // ---- Locomotion -------------------------------------------------------

  wanderWithin(radius) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.5 + Math.random() * (radius - 3);
    this.setTarget(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }

  setTarget(v) { this.target = v ? v.clone().setY(0) : null; }

  update(dt, elapsed) {
    const m = MOODS[this.mood];
    const t = elapsed;

    // --- Blob deformation -------------------------------------------
    const pos = this.torso.geometry.attributes.position;
    const base = this.torsoBase;
    const amp = 0.045 * (this.mood === 'sleeping' ? 0.5 : 1);
    for (let i = 0; i < pos.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
      const n = Math.sin(bx * 3.1 + t * 1.7) * Math.cos(by * 2.6 + t * 1.3) * Math.sin(bz * 2.9 + t * 1.1);
      const breathe = 1 + Math.sin(t * 1.9 * m.breath) * 0.035;
      const k = breathe + n * amp;
      pos.setXYZ(i, bx * k, by * k, bz * k);
    }
    pos.needsUpdate = true;
    this.torso.geometry.computeVertexNormals();

    // --- Idle motion -------------------------------------------------
    const bob = Math.sin(t * 2.0 * m.bob) * 0.055;
    this.body.position.y = bob;
    this.body.rotation.z = Math.sin(t * 0.9) * 0.03;

    for (const { pivot, side } of this.ears) {
      const twitch = Math.sin(t * 2.4 + side) > 0.93 ? 0.35 : 0;
      pivot.rotation.z = side * (0.3 - m.earLift * 0.35) + side * twitch;
      pivot.rotation.x = -m.earLift * 0.25 + Math.sin(t * 1.4 + side) * 0.05;
    }
    this.head.rotation.x = -m.headTilt + Math.sin(t * 0.8) * 0.035;
    this.head.rotation.z = Math.sin(t * 0.62) * 0.05;

    for (const { pivot, side } of this.arms) {
      pivot.rotation.x = Math.sin(t * 2.2 + side * 1.4) * 0.35 * m.speed;
      pivot.rotation.z = side * (0.35 + Math.sin(t * 1.1) * 0.06);
    }
    this.tailPivot.rotation.y = Math.sin(t * 3.2) * 0.4 * m.speed;
    this.tailPivot.rotation.x = Math.sin(t * 2.1) * 0.15;

    if (this.wings.visible) {
      const flap = Math.sin(t * (this.mood === 'sleeping' ? 1.2 : 7)) * 0.5;
      this.wings.children.forEach((w, i) => {
        const side = i === 0 ? -1 : 1;
        w.rotation.y = side * (0.7 + flap * 0.45);
      });
    }
    if (this.aura.material.opacity > 0) {
      this.aura.rotation.z = t * 0.6;
      this.aura.scale.setScalar(1 + Math.sin(t * 2) * 0.05);
    }

    // --- Blinking ----------------------------------------------------
    this.blinkAt -= dt;
    if (this.blinkAt <= 0 && this.blinkT < 0) { this.blinkT = 0.13; this.blinkAt = 2.5 + Math.random() * 4; }
    if (this.blinkT > 0) this.blinkT -= dt;
    const blinking = this.blinkT > 0 || this.mood === 'sleeping';
    for (const eye of this.eyes) eye.lid.visible = blinking;

    // --- Hop ---------------------------------------------------------
    let hopY = 0;
    if (this.hopTime >= 0) {
      this.hopTime += dt * 3.4;
      const power = this.hopPower ?? 1.1;
      hopY = Math.max(0, Math.sin(this.hopTime * Math.PI)) * 0.55 * power;
      if (this.hopTime >= 1) this.hopTime = -1;
    }

    // --- Movement toward target --------------------------------------
    if (this.target) {
      const to = new THREE.Vector3().subVectors(this.target, this.group.position);
      to.y = 0;
      const dist = to.length();
      if (dist < 0.35) {
        this.target = null;
      } else {
        to.normalize();
        const speed = 1.5 * m.speed * (this.mood === 'restless' ? 1.5 : 1);
        this.velocity.lerp(to.multiplyScalar(speed), Math.min(1, dt * 5));
        this.group.position.addScaledVector(this.velocity, dt);
        const facing = Math.atan2(this.velocity.x, this.velocity.z);
        let d = facing - this.group.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.group.rotation.y += d * Math.min(1, dt * 7);
        this.body.rotation.x = Math.sin(t * 9) * 0.05 * m.speed;
      }
    } else {
      this.velocity.multiplyScalar(Math.pow(0.02, dt));
      this.body.rotation.x *= Math.pow(0.1, dt);
    }

    // Clamp inside the sanctuary and sit on the terrain.
    const R = 13.2;
    const p = this.group.position;
    const d = Math.hypot(p.x, p.z);
    if (d > R) { p.x *= R / d; p.z *= R / d; }
    p.y = this.groundHeight(p.x, p.z) + hopY;
    // contactShadow is parented to the group, so its local offset is just the hop.
    this.contactShadow.position.y = 0.03 - hopY;
    this.contactShadow.material.opacity = Math.max(0.06, 0.24 - hopY * 0.2);

    // --- Emissive pulse on rewards ------------------------------------
    if (this.emissivePulse > 0) {
      this.emissivePulse = Math.max(0, this.emissivePulse - dt * 1.4);
      this.skinMat.emissive.copy(this.baseColor).multiplyScalar(this.emissivePulse * 0.8);
      this.skinMat.emissiveIntensity = this.emissivePulse;
    } else {
      this.skinMat.emissiveIntensity = 0;
    }
  }

  get position() { return this.group.position; }
}

// ---- Throwable toy ------------------------------------------------------
// Simple ballistic body with ground restitution; Lumi chases it while it moves.
export class Toy {
  constructor(scene, { groundHeight = () => 0 } = {}) {
    this.groundHeight = groundHeight;
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0xff6f91, roughness: 0.35, metalness: 0.1, emissive: 0x4a0f22, emissiveIntensity: 0.4 })
    );
    this.mesh.castShadow = true;
    const stripe = new THREE.Mesh(
      new THREE.TorusGeometry(0.285, 0.045, 8, 32),
      new THREE.MeshStandardMaterial({ color: 0xfff0a8, roughness: 0.4 })
    );
    stripe.rotation.x = Math.PI / 2;
    this.mesh.add(stripe);
    scene.add(this.mesh);
    this.vel = new THREE.Vector3();
    this.atRest = true;
    this.mesh.position.set(1.6, 0.28, 1.6);
  }

  throwTo(point) {
    const from = this.mesh.position.clone();
    const delta = new THREE.Vector3().subVectors(point, from);
    const flat = Math.hypot(delta.x, delta.z);
    this.vel.set(delta.x * 1.1, 4.2 + flat * 0.22, delta.z * 1.1);
    this.atRest = false;
  }

  update(dt) {
    if (this.atRest) {
      this.mesh.position.y = this.groundHeight(this.mesh.position.x, this.mesh.position.z) + 0.28;
      return;
    }
    this.vel.y -= 15 * dt;
    this.mesh.position.addScaledVector(this.vel, dt);
    this.mesh.rotation.x += dt * 6;
    this.mesh.rotation.z += dt * 4;

    const floor = this.groundHeight(this.mesh.position.x, this.mesh.position.z) + 0.28;
    if (this.mesh.position.y <= floor) {
      this.mesh.position.y = floor;
      this.vel.y = -this.vel.y * 0.52;
      this.vel.x *= 0.72;
      this.vel.z *= 0.72;
      if (Math.abs(this.vel.y) < 0.7) {
        this.vel.set(0, 0, 0);
        this.atRest = true;
      }
    }
    const d = Math.hypot(this.mesh.position.x, this.mesh.position.z);
    if (d > 13) {
      this.mesh.position.x *= 13 / d;
      this.mesh.position.z *= 13 / d;
      this.vel.x *= -0.5; this.vel.z *= -0.5;
    }
  }
}
