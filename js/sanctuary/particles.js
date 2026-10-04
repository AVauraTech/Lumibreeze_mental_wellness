// GPU-friendly point-sprite bursts: hearts on petting, sparkles on level-up,
// water droplets on bathing, stars on evolution.

import * as THREE from 'three';

const SPRITES = {
  heart: makeSpriteTexture('💜'),
  sparkle: makeSpriteTexture('✨'),
  star: makeSpriteTexture('⭐'),
  droplet: makeSpriteTexture('💧'),
  leaf: makeSpriteTexture('🍃'),
  zzz: makeSpriteTexture('💤'),
};

function makeSpriteTexture(char) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  c.font = `${size * 0.78}px serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(char, size / 2, size / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class Burst {
  constructor(scene, kind, count = 18) {
    const positions = new Float32Array(count * 3);
    this.velocities = [];
    this.life = 0;
    this.maxLife = 1.9;
    this.count = count;

    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 1.1 + Math.random() * 2.1;
      this.velocities.push(new THREE.Vector3(
        Math.cos(a) * speed * 0.6,
        2.2 + Math.random() * 2.6,
        Math.sin(a) * speed * 0.6
      ));
      positions[i * 3] = 0; positions[i * 3 + 1] = 0; positions[i * 3 + 2] = 0;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry = geo;

    this.material = new THREE.PointsMaterial({
      size: kind === 'sparkle' ? 0.28 : 0.42,
      map: SPRITES[kind] ?? SPRITES.sparkle,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  update(dt) {
    this.life += dt;
    const pos = this.geometry.attributes.position.array;
    for (let i = 0; i < this.count; i++) {
      const v = this.velocities[i];
      v.y -= 5.4 * dt;                     // gravity
      pos[i * 3] += v.x * dt;
      pos[i * 3 + 1] += v.y * dt;
      pos[i * 3 + 2] += v.z * dt;
      if (pos[i * 3 + 1] < 0.05) { pos[i * 3 + 1] = 0.05; v.y *= -0.34; v.x *= 0.7; v.z *= 0.7; }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.material.opacity = Math.max(0, 1 - this.life / this.maxLife);
    return this.life < this.maxLife;
  }

  dispose(scene) {
    scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class ParticleDirector {
  constructor(scene) {
    this.scene = scene;
    this.bursts = [];
  }

  emit(kind, position, count = 18) {
    const b = new Burst(this.scene, kind, count);
    b.points.position.copy(position);
    this.bursts.push(b);
    if (this.bursts.length > 12) {
      this.bursts.shift().dispose(this.scene);
    }
  }

  update(dt) {
    this.bursts = this.bursts.filter((b) => {
      const alive = b.update(dt);
      if (!alive) b.dispose(this.scene);
      return alive;
    });
  }
}
