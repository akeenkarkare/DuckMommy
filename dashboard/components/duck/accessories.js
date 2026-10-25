import * as THREE from 'three';

// What the duck wears for its coach personality (settings.coach_tone):
//   gentle -> nothing · coach -> red cap + whistle on a lanyard · savage -> black aviators
// Primitives only, like buildDuck.js. Nothing here is tagged as a hotspot (not clickable).
// Cap + shades ride on duck.neck (head shakes, looks); the lanyard rides on the body group
// under squash, so it squishes with the body on a pat.
//
//   const acc = buildAccessories(duck);
//   acc.set('savage');        // old ones pop away (150 ms), new ones spring on (450 ms)
//   acc.update(dt, t);        // every frame
//   acc.blow();               // coach: the whistle puffs (focus session started)

const TAU = Math.PI * 2;
const H = new THREE.Vector3(0, 0.53, 0.05);   // head centre, relative to the neck pivot (buildDuck.js)
const easeOutBack = (x) => { const c1 = 2.4, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; };   // peaks ~1.15

function physical(color, extra = {}) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: 0.5, ...extra });
}

function shadowed(root) {
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return root;
}

/** A thin cylinder from a to b. */
function rod(a, b, radius, material) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, dir.length(), 12), material);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

function buildShades() {
  const root = new THREE.Group();
  const tilt = new THREE.Group();   // a little attitude
  tilt.position.copy(H).add(new THREE.Vector3(0, 0.2, 0.6));
  tilt.rotation.z = THREE.MathUtils.degToRad(-6);
  root.add(tilt);
  const frame = new THREE.Group();
  frame.position.copy(tilt.position).negate();   // children use neck coordinates
  tilt.add(frame);

  // slightly see-through, so the camera lens under the left one still reads in the Camera zoom
  const lensMat = physical('#0b0b0f', { roughness: 0.05, metalness: 0.6, clearcoat: 1, transparent: true, opacity: 0.78 });
  const gold = physical('#d4af37', { metalness: 1, roughness: 0.25 });
  const glints = [];
  for (const side of [-1, 1]) {
    const dir = new THREE.Vector3(side * 0.49, 0.27, 0.82).normalize();   // same as the eyes
    const lens = new THREE.Group();
    lens.position.copy(H).addScaledVector(dir, 0.76);
    lens.lookAt(lens.position.clone().add(dir));
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 48), lensMat);
    glass.rotation.x = Math.PI / 2;
    glass.scale.set(1.2, 1, 0.9);   // aviator oval, a touch wider than tall
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.014, 10, 64), gold);
    rim.scale.set(1.2, 0.9, 1);
    // glint: a thin bright bar that sweeps across now and then
    const glint = new THREE.Mesh(new THREE.PlaneGeometry(0.035, 0.34),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }));
    glint.position.z = 0.02;
    glint.rotation.z = 0.5;
    lens.add(glass, rim, glint);
    frame.add(lens);
    glints.push(glint);
  }
  frame.updateMatrixWorld(true);   // so the lens corners below come out in frame coordinates
  const edge = (side) => {
    const lens = frame.children[side === -1 ? 0 : 1];
    return frame.worldToLocal(lens.localToWorld(new THREE.Vector3(side * 0.24, 0.03, -0.01)));
  };
  // bridge over the top of the beak
  const l = frame.worldToLocal(frame.children[0].localToWorld(new THREE.Vector3(0.21, 0.05, 0)));
  const r = frame.worldToLocal(frame.children[1].localToWorld(new THREE.Vector3(-0.21, 0.05, 0)));
  const mid = l.clone().add(r).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.035, 0.04));
  frame.add(rod(l, mid, 0.014, gold), rod(mid, r, 0.014, gold));
  // arms back along the sides of the head
  for (const side of [-1, 1]) {
    const a = edge(side);
    const b = new THREE.Vector3(side * 0.66, H.y + 0.2, H.z - 0.12);
    frame.add(rod(a, b, 0.013, gold));
  }
  return { root: shadowed(root), glints };
}

function buildCap() {
  const root = new THREE.Group();
  const red = physical('#d62839', { roughness: 0.65 });
  const crown = new THREE.Group();
  crown.position.copy(H).add(new THREE.Vector3(0, 0.04, -0.04));
  crown.rotation.x = -0.12;   // tipped back a little so the front edge clears the eyes
  root.add(crown);
  // open at the very top so the touch ring (the press-to-quack pad) shows through
  const R = 0.71, OPEN = 0.33, EDGE = 1.2;   // radius, opening and brim edge (radians from the top)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 24, 0, TAU, OPEN, EDGE - OPEN), red);
  dome.material.side = THREE.DoubleSide;
  crown.add(dome);
  // stitched rim around the opening
  const seam = new THREE.Mesh(new THREE.TorusGeometry(R * Math.sin(OPEN), 0.018, 10, 48), physical('#b5222f', { roughness: 0.7 }));
  seam.rotation.x = Math.PI / 2;
  seam.position.y = R * Math.cos(OPEN);
  crown.add(seam);
  // brim: a flattened half disc, forward over the beak
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.03, 48, 1, false, -Math.PI / 2, Math.PI), red);
  brim.position.set(0, R * Math.cos(EDGE) - 0.01, R * Math.sin(EDGE) - 0.2);
  brim.scale.set(0.95, 1, 1);
  brim.rotation.x = 0.2;   // front dips a little
  crown.add(brim);
  return { root: shadowed(root) };
}

function buildWhistle() {
  const root = new THREE.Group();   // body (inner) coordinates: the neck pivot is at (0, 0.62, 0.25)
  const blue = physical('#1d4ed8', { roughness: 0.55 });
  const chrome = physical('#e8e8ee', { metalness: 1, roughness: 0.15 });
  // lanyard where the head meets the body: on the chest at the front, tucked under the head at the back
  const lanyard = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.025, 10, 80), blue);
  lanyard.position.set(0, 0.685, 0.35);
  lanyard.rotation.x = Math.PI / 2 + 0.12;   // + tilts the front down
  root.add(lanyard);
  // short cord + whistle hanging on the chest
  const top = new THREE.Vector3(0, 0.61, 0.945), hang = new THREE.Vector3(0, 0.53, 1.0);
  root.add(rod(top, hang, 0.012, blue));
  const whistle = new THREE.Group();
  whistle.position.set(0.02, 0.46, 1.02);
  whistle.rotation.set(-0.3, 0, -0.25);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.15, 24), chrome);
  barrel.rotation.z = Math.PI / 2;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 24, 16), chrome);
  bulb.position.x = 0.07;
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.045, 0.06), chrome);
  mouth.position.x = -0.1;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.006, 8, 16), chrome);
  ring.position.set(0, 0.07, 0);
  whistle.add(barrel, bulb, mouth, ring);
  root.add(whistle);
  return { root: shadowed(root), whistle };
}

export function buildAccessories(duck) {
  const body = duck.squash.children[0];   // the body group under squash (buildDuck's `inner`)
  const shades = buildShades();
  const cap = buildCap();
  const whistle = buildWhistle();
  duck.neck.add(shades.root, cap.root);
  body.add(whistle.root);

  // each piece: shown scale `s`, tweening from `from` to `to` over `dur` seconds
  const items = {
    shades: { root: shades.root, s: 0, from: 0, to: 0, t: 1, dur: 0.45 },
    cap: { root: cap.root, s: 0, from: 0, to: 0, t: 1, dur: 0.45 },
    whistle: { root: whistle.root, s: 0, from: 0, to: 0, t: 1, dur: 0.45 },
  };
  const WEARS = { gentle: [], coach: ['cap', 'whistle'], savage: ['shades'] };
  let tone = null, reduced = false, blowT = 1, nextGlint = 4;

  const apply = (it, s) => {
    it.s = s;
    it.root.scale.setScalar(Math.max(0.0001, s));
    it.root.visible = s > 0.001;
  };
  Object.values(items).forEach((it) => apply(it, 0));

  return {
    get tone() { return tone; },
    /** Wear the outfit for `next`. Returns true if anything changed (the caller hops). */
    set(next, { instant = false } = {}) {
      if (!WEARS[next] || next === tone) return false;
      tone = next;
      for (const [id, it] of Object.entries(items)) {
        const on = WEARS[next].includes(id) ? 1 : 0;
        if (it.to === on) continue;
        if (instant || reduced) { it.to = on; it.t = 1; apply(it, on); continue; }
        Object.assign(it, { from: it.s, to: on, t: 0, dur: on ? 0.45 : 0.15 });
      }
      return true;
    },
    setReduced(v) { reduced = v; },
    blow() { if (items.whistle.to === 1) blowT = 0; },
    update(dt, time) {
      for (const it of Object.values(items)) {
        if (it.t >= 1) continue;
        it.t = Math.min(1, it.t + dt / it.dur);
        apply(it, it.to ? it.from + (1 - it.from) * easeOutBack(it.t) : it.from * (1 - it.t));
      }
      // whistle puff: 1 -> 1.3 -> 1
      if (blowT < 1) {
        blowT = Math.min(1, blowT + dt / 0.5);
        whistle.whistle.scale.setScalar(1 + 0.3 * Math.sin(blowT * Math.PI));
      }
      // savage: a glint sweeps across the lenses every ~6 s
      if (!reduced && items.shades.s > 0.5) {
        if (time > nextGlint) nextGlint = time + 6;
        const p = clamp01((time - (nextGlint - 6)) / 0.6);   // the sweep takes the first 0.6 s of each cycle
        for (const glint of shades.glints) {
          glint.position.x = -0.3 + p * 0.6;
          glint.material.opacity = p > 0 && p < 1 ? Math.sin(p * Math.PI) * 0.75 : 0;
        }
      }
    },
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
