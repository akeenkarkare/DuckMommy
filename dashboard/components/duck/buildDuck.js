import * as THREE from 'three';

// A rubber duck made of primitives. No model file: every part is a mesh we can animate.
//
//   group (yaw/pitch, set by the stage)
//    └ bob (float + hop)
//       └ squash (squish on pats)
//          ├ body, chest, tail, wings, mic grille, NFC tag
//          └ neck (head tilt / shake / look)
//             └ head, eyes (one is the camera lens), upper beak, touch ring
//                └ jaw (lower beak, flaps while talking)

const YELLOW = '#ffbf1f';
const ORANGE = '#ff7a1a';

function mat(color, extra = {}) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.4, clearcoat: 0.55, clearcoatRoughness: 0.3, ...extra,
  });
}

function blob(r, scale, pos, material, rot = [0, 0, 0]) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 48), material);
  m.scale.set(...scale);
  m.position.set(...pos);
  m.rotation.set(...rot);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildDuck() {
  const yellow = mat(YELLOW);
  const orange = mat(ORANGE, { roughness: 0.28 });
  const black = mat('#0c0c0d', { roughness: 0.12, clearcoat: 1 });

  const group = new THREE.Group();
  const bob = new THREE.Group();
  const squash = new THREE.Group();
  group.add(bob);
  bob.add(squash);
  squash.position.y = -0.9;           // squish from the base, not the middle
  const inner = new THREE.Group();
  inner.position.y = 0.9;
  squash.add(inner);

  const tag = (mesh, hotspot) => { mesh.userData.hotspot = hotspot; return mesh; };

  // ── body ──────────────────────────────────────────────────────────────────
  inner.add(blob(1, [1.15, 0.88, 1.22], [0, 0, -0.05], yellow));   // body: click = pet
  inner.add(tag(blob(0.82, [1, 0.92, 0.95], [0, 0.05, 0.35], yellow), 'microphone'));
  inner.add(tag(blob(0.5, [0.78, 0.55, 1.05], [0, 0.42, -1.12], yellow, [0.75, 0, 0]), 'focus'));
  for (const side of [-1, 1]) {
    inner.add(blob(0.6, [0.17, 0.5, 1.0], [side * 1.03, 0.1, -0.22], yellow, [0.1, side * 0.08, -side * 0.12]));
  }

  // microphone grille: pinholes placed on the chest's curved surface (chest ellipsoid below)
  const C = new THREE.Vector3(0, 0.05, 0.35), R = new THREE.Vector3(0.82, 0.82 * 0.92, 0.82 * 0.95);
  const holeGeo = new THREE.SphereGeometry(0.034, 16, 12);
  const holes = new THREE.Group();
  holes.userData.hotspot = 'microphone';
  [[0, 0], [0.1, 0], [-0.1, 0], [0.05, 0.087], [-0.05, 0.087], [0.05, -0.087], [-0.05, -0.087]].forEach(([dx, dy]) => {
    const x = dx, y = -0.2 + dy;
    const z = C.z + R.z * Math.sqrt(1 - (x / R.x) ** 2 - ((y - C.y) / R.y) ** 2);
    const n = new THREE.Vector3(x / R.x ** 2, (y - C.y) / R.y ** 2, (z - C.z) / R.z ** 2).normalize();
    const h = new THREE.Mesh(holeGeo, black);
    h.position.set(x, y, z);   // flattened dark disc, flush with the surface
    h.lookAt(h.position.clone().add(n));
    h.scale.z = 0.3;
    holes.add(h);
  });
  inner.add(holes);

  // NFC focus tag on the back
  const shape = new THREE.Shape();
  const w = 0.26, r = 0.06;
  shape.moveTo(-w / 2 + r, -w / 2);
  shape.lineTo(w / 2 - r, -w / 2); shape.quadraticCurveTo(w / 2, -w / 2, w / 2, -w / 2 + r);
  shape.lineTo(w / 2, w / 2 - r); shape.quadraticCurveTo(w / 2, w / 2, w / 2 - r, w / 2);
  shape.lineTo(-w / 2 + r, w / 2); shape.quadraticCurveTo(-w / 2, w / 2, -w / 2, w / 2 - r);
  shape.lineTo(-w / 2, -w / 2 + r); shape.quadraticCurveTo(-w / 2, -w / 2, -w / 2 + r, -w / 2);
  const nfc = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 3 }),
    mat('#1d1d22', { roughness: 0.4, iridescence: 0.8, iridescenceIOR: 1.6 }));
  nfc.position.set(0, 0.615, -0.915);   // flush on the body's surface, normal (0, 0.8, -0.58)
  nfc.lookAt(0, 0.63 + 0.8 * 3, -0.93 - 0.58 * 3);
  tag(nfc, 'focus');
  inner.add(nfc);

  // ── head ──────────────────────────────────────────────────────────────────
  const neck = new THREE.Group();
  neck.position.set(0, 0.62, 0.25);
  inner.add(neck);
  const H = new THREE.Vector3(0, 1.15 - 0.62, 0.3 - 0.25);   // head centre, relative to the neck pivot
  neck.add(tag(blob(0.68, [1, 0.97, 1], H.toArray(), yellow), 'petting'));

  // touch ring on top: where the pressure sensor sits
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.014, 12, 64),
    new THREE.MeshPhysicalMaterial({ color: '#ffb000', emissive: '#ff9d00', emissiveIntensity: 0.25, roughness: 0.3 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, H.y + 0.632, H.z - 0.02);   // sunk into the head, not floating
  tag(ring, 'petting');
  neck.add(ring);

  // beak: upper is fixed, lower (jaw) flaps
  neck.add(tag(blob(0.32, [1.22, 0.36, 1.12], [0, H.y - 0.1, H.z + 0.64], orange, [-0.08, 0, 0]), 'voice'));
  const jaw = new THREE.Group();
  jaw.position.set(0, H.y - 0.18, H.z + 0.42);
  jaw.add(tag(blob(0.27, [1.08, 0.3, 0.95], [0, -0.03, 0.18], orange), 'voice'));
  neck.add(jaw);

  // eyes: viewer's right is a normal eye, viewer's left is the camera lens
  const eyeDir = (x) => new THREE.Vector3(x, 0.27, 0.82).normalize();
  const eyes = [];

  const plainDir = eyeDir(0.49);
  const plain = new THREE.Group();
  plain.position.copy(H).addScaledVector(plainDir, 0.665);
  plain.lookAt(plain.position.clone().add(plainDir));
  const pupil = blob(0.105, [1, 1.12, 0.45], [0, 0, 0], black);
  const shine = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  shine.position.set(0.03, 0.04, 0.045);
  plain.add(pupil, shine);
  neck.add(plain);
  eyes.push(plain);

  const lensDir = eyeDir(-0.49);
  const lens = new THREE.Group();
  lens.position.copy(H).addScaledVector(lensDir, 0.66);
  lens.lookAt(lens.position.clone().add(lensDir));
  const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.022, 16, 48),
    new THREE.MeshPhysicalMaterial({ color: '#2b2b30', metalness: 0.9, roughness: 0.25 }));
  const glass = blob(0.1, [1, 1, 0.42], [0, 0, 0],
    new THREE.MeshPhysicalMaterial({ color: '#07070a', roughness: 0.05, clearcoat: 1, iridescence: 1, iridescenceIOR: 1.8, emissive: '#ff2a2a', emissiveIntensity: 0 }));
  const lensShine = shine.clone();
  lensShine.position.set(0.035, 0.035, 0.04);
  lens.add(bezel, glass, lensShine);
  [bezel, glass].forEach((m) => tag(m, 'camera'));
  neck.add(lens);
  eyes.push(lens);

  // ── reaction props ────────────────────────────────────────────────────────
  // sound ripples at the microphone
  const ripples = [];
  for (let i = 0; i < 3; i++) {
    const rip = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.012, 8, 64),
      new THREE.MeshBasicMaterial({ color: '#ffd84d', transparent: true, opacity: 0, depthWrite: false }));
    rip.position.set(0, -0.2, 1.12);
    rip.rotation.x = -0.2;
    inner.add(rip);
    ripples.push(rip);
  }

  return { group, bob, squash, neck, jaw, eyes, lensMaterial: glass.material, ringMaterial: ring.material, ripples };
}

// Soft warm glow on the floor under the duck.
export function buildGlow() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255, 196, 60, 0.55)');
  grad.addColorStop(0.45, 'rgba(255, 140, 30, 0.16)');
  grad.addColorStop(1, 'rgba(255, 120, 0, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(6, 6),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = -0.915;
  return glow;
}
