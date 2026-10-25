'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { buildDuck, buildGlow } from './buildDuck';
import { buildAccessories } from './accessories';
import { buildWater } from './water';
import { sceneById } from './scenes';
import { HOTSPOTS } from './hotspots';
import { useDuck } from './DuckContext';

// One WebGL scene for the whole app. It lives in the root layout, so moving from
// login to the dashboard is a single continuous animation (the duck spins and shrinks).

const PANEL_W = 460;          // px the side panel covers on wide screens
const WIDE = 900;             // below this, panels are bottom sheets
const TAU = Math.PI * 2;
const PRESETS = {
  hero: { cam: [0, 1.0, 3.7], target: [0, 0.85, 0], yaw: 0, pitch: 0.04 },
  heroNarrow: { cam: [0, 1.1, 7.2], target: [0, 0.75, 0], yaw: 0, pitch: 0.04 },
  dashboard: { cam: [0, 0.8, 9.2], target: [0, 0.45, 0], yaw: 0.42, pitch: 0.14 },
  dashboardNarrow: { cam: [0, 0.9, 15], target: [0, 0.45, 0], yaw: 0.42, pitch: 0.14 },
};
const GROUND_Y = -0.92;
// Non-hotspot focus ids: the whole duck slides left, clear of the drawer, with its labels hidden.
const ASIDE = new Set(['activity', 'calendar', 'nest', 'aside']);
const LABEL_DY = { camera: -0.06, petting: -0.1, voice: 0.02, microphone: 0.1, focus: -0.12 };

const nearest = (angle, ref) => angle + TAU * Math.round((ref - angle) / TAU);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOutBack = (x) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;

export default function DuckStage() {
  const { mode, focus, setFocus, badges, bridge, scene: sceneId, tone } = useDuck();
  const mountRef = useRef(null);
  const labelRefs = useRef({});
  const lineRefs = useRef({});
  const dotRefs = useRef({});
  const bubbleRef = useRef(null);
  const live = useRef({ mode, focus, setFocus, sceneId, tone });   // what the render loop reads
  const ctrl = useRef(null);                        // render-loop state, created on mount

  live.current.setFocus = setFocus;

  // mode / focus changes: set new goals (the loop eases toward them)
  useEffect(() => {
    const c = ctrl.current;
    const prev = live.current.mode;
    live.current.mode = mode;
    if (!c || prev === mode) return;
    if (mode === 'dashboard') {
      // one celebratory spin while shrinking into place
      c.userYaw = c.reduced ? PRESETS.dashboard.yaw : c.S.yaw + TAU + ((PRESETS.dashboard.yaw - c.S.yaw) % TAU + TAU) % TAU;
      c.userPitch = PRESETS.dashboard.pitch;
      c.lastInput = performance.now() / 1000;
    }
  }, [mode]);

  useEffect(() => {
    live.current.focus = focus;
  }, [focus]);

  useEffect(() => {
    live.current.sceneId = sceneId;
    ctrl.current?.applyScene(sceneId);
  }, [sceneId]);

  // personality outfit: swap with a pop and a little hop
  useEffect(() => {
    live.current.tone = tone;
    ctrl.current?.setTone(tone);
  }, [tone]);

  useEffect(() => {
    const mount = mountRef.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ── renderer / scene ────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.NeutralToneMapping;   // keeps the duck properly yellow
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;

    const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 5000);   // far: water to the horizon

    const key = new THREE.DirectionalLight('#fff1d6', 2.8);
    key.position.set(3, 6, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -3;
    key.shadow.camera.right = key.shadow.camera.top = 3;
    key.shadow.radius = 6;
    const rim = new THREE.DirectionalLight('#8db4ff', 1.6);
    rim.position.set(-5, 2.5, -4);
    const fill = new THREE.HemisphereLight('#fff6e0', '#1a1206', 0.35);
    scene.add(key, rim, fill);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.38 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    ground.receiveShadow = true;
    const glow = buildGlow();
    scene.add(ground, glow);

    const duck = buildDuck();
    scene.add(duck.group);
    const acc = buildAccessories(duck);
    acc.setReduced(reduced);
    acc.set(live.current.tone, { instant: true });
    const water = buildWater();
    water.mesh.visible = false;
    scene.add(water.mesh);
    const meshes = [];
    duck.group.traverse((o) => o.isMesh && meshes.push(o));

    // ── state ───────────────────────────────────────────────────────────────
    const narrow = () => window.innerWidth < WIDE;
    const startPreset = PRESETS[(live.current.mode === 'dashboard' ? 'dashboard' : 'hero') + (narrow() ? 'Narrow' : '')];
    const c = {
      reduced,
      S: {   // smoothed (what's on screen)
        cam: new THREE.Vector3(...startPreset.cam),
        target: new THREE.Vector3(...startPreset.target),
        offX: 0, offY: 0, yaw: startPreset.yaw - 1.2, pitch: startPreset.pitch, labels: 0,
      },
      userYaw: startPreset.yaw, userPitch: startPreset.pitch,
      yawVel: 0, pitchVel: 0, lastInput: -10,
      pointer: { x: 0, y: 0, known: false },   // last pointer position, px
      look: { body: 0, neckYaw: 0, neckPitch: 0 },   // hero: where the duck is looking
      drag: null,
      squish: 0, squishV: 0, hopY: 0, hopV: 0, shake: 0, talk: 0, lens: 0, ring: 0,
      ripples: [], nextBlink: 2, blink: 0,
      bubbleUntil: 0, sides: {},
      intro: 0,
      elastic: { yaw: 0, pitch: 0, vy: 0, vp: 0 },   // tab open: drag offset that springs back
      water: false, nextVoiceRip: 0, nextIdleRip: 1, splash: 0, airborne: false, nextScrollSplash: 0,
    };
    ctrl.current = c;

    // ── background scenes (HDR panoramas) ──────────────────────────────────
    const hdrLoader = new HDRLoader();
    const loaded = new Map();   // scene id -> { tex, env }
    let wanted = null, disposed = false, firstScene = true;
    const fade = (on) => { mount.style.opacity = on ? '1' : '0'; };
    const applyScene = async (id) => {
      const cfg = sceneById(id);
      wanted = cfg.id;
      let entry = loaded.get(cfg.id);
      if (!entry) {
        try {
          const tex = await hdrLoader.loadAsync(`/scenes/${cfg.file}_2k.hdr`);
          tex.mapping = THREE.EquirectangularReflectionMapping;
          entry = { tex, env: pmrem.fromEquirectangular(tex).texture };
          loaded.set(cfg.id, entry);
        } catch (err) {
          console.warn(`Background "${cfg.id}" is missing. Run: npm run get-scenes`, err);
          return;
        }
      }
      if (disposed || wanted !== cfg.id) return;
      if (!firstScene) { fade(false); await new Promise((r) => setTimeout(r, 280)); }
      if (disposed || wanted !== cfg.id) return;
      scene.background = entry.tex;
      scene.backgroundRotation.set(0, cfg.rot, 0);
      scene.environment = entry.env;
      scene.environmentRotation.set(0, cfg.rot, 0);
      scene.environmentIntensity = 1;
      renderer.toneMappingExposure = cfg.exposure;
      key.intensity = 1.7; rim.intensity = 0.5; fill.intensity = 0.1;   // the panorama does most of the lighting
      c.water = true;   // every scene is open water now
      water.setColor(cfg.water);
      water.mesh.visible = true;
      ground.visible = false;
      glow.visible = false;
      firstScene = false;
      fade(true);
    };
    c.applyScene = applyScene;
    applyScene(live.current.sceneId);

    // ── reactions (called by the dashboard for live events) ──────────────────
    const bubble = (text, ms = 2600) => {
      const el = bubbleRef.current;
      if (!el || !text) return;
      el.textContent = text;
      el.classList.remove('pop');
      void el.offsetWidth;   // restart the pop animation
      el.classList.add('pop');
      c.bubbleUntil = performance.now() + ms;
    };
    const squish = () => { c.squishV -= reduced ? 0 : 5.5; c.ring = 1; c.splash = 0.07; };
    const hop = (v = 2.4) => { if (!reduced) c.hopV = v; };
    const talk = (text) => { c.talk = Math.min(4, 0.6 + (text?.length ?? 8) * 0.055); };
    const ripple = () => { const t = performance.now() / 1000; c.ripples = [t, t + 0.25, t + 0.5]; };

    c.setTone = (t) => { if (acc.set(t)) hop(1.6); };
    bridge.current.setTone = c.setTone;

    bridge.current.react = (e) => {
      const v = e.value ?? {};
      switch (e.type) {
        case 'pat': case 'quack': squish(); bubble('Quack!', 1400); break;
        case 'posture':
          if (v.state === 'slouch') { c.shake = 1; bubble(e.message || 'Sit up straight!'); talk(e.message); }
          else { hop(1.6); bubble('Nice posture ✨', 1800); }
          break;
        case 'sign': talk(v.text); bubble(`“${v.text}”`, 4500); break;
        case 'sound': ripple(); bubble(`🔔 ${e.label || v.label || v.kind}`, 2600); break;
        case 'sentry': if (v.person_confirmed) { c.lens = 1; c.shake = 0.6; bubble(e.message || 'Who goes there?'); } break;
        case 'presence': if (v.present) { hop(); bubble(e.message || 'Welcome back!'); } break;
        case 'focus': hop(2); bubble('Focus mode 🎯', 2200); break;
        case 'say': talk(v.text); bubble(v.text, 3500); break;
        case 'calendar': talk(v.text); bubble(`📅 ${v.text}`, 5000); break;
        case 'whistle': acc.blow(); ripple(); break;   // coach: focus session started
        case 'wink': c.blink = 0.45; c.nextBlink = performance.now() / 1000 + 3; break;   // eyes[0] is the only eye that blinks
        default: break;
      }
    };

    // ── input ───────────────────────────────────────────────────────────────
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hit = (x, y) => {
      ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const h = raycaster.intersectObjects(meshes, false)[0];
      if (!h) return null;
      for (let o = h.object; o; o = o.parent) if (o.userData.hotspot) return o.userData.hotspot;
      return 'body';
    };
    const canvas = renderer.domElement;
    const onDown = (e) => {
      c.drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      const now = performance.now() / 1000;
      c.pointer.x = e.clientX; c.pointer.y = e.clientY; c.pointer.known = true;
      const d = c.drag;
      if (d) {
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        d.x = e.clientX; d.y = e.clientY;
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5) d.moved = true;
        if (d.moved && live.current.mode === 'dashboard' && !live.current.focus) {
          c.userYaw += dx * 0.009;
          c.userPitch = clamp(c.userPitch + dy * 0.006, -0.35, 1.35);
          c.yawVel = dx * 0.009 * 60;
          c.lastInput = now;
          canvas.style.cursor = 'grabbing';
        } else if (d.moved && live.current.mode === 'dashboard') {
          // a tab is open: the duck can still be twisted, with rubber-band resistance,
          // and springs back to its pose on release (see the elastic spring in the loop)
          const e = c.elastic;
          e.yaw += dx * 0.009 / (1 + Math.abs(e.yaw) * 1.2);
          e.pitch = clamp(e.pitch + dy * 0.006 / (1 + Math.abs(e.pitch) * 1.5), -0.9, 0.9);
          e.vy = e.vp = 0;
          canvas.style.cursor = 'grabbing';
        }
        return;
      }
      const h = hit(e.clientX, e.clientY);
      canvas.style.cursor = h ? 'pointer' : live.current.mode === 'dashboard' ? 'grab' : 'default';
    };
    const onUp = (e) => {
      const d = c.drag;
      c.drag = null;
      if (!d) return;
      canvas.style.cursor = live.current.mode === 'dashboard' ? 'grab' : 'default';
      if (d.moved) return;
      const h = hit(e.clientX, e.clientY);
      if (live.current.mode !== 'dashboard') {
        if (h) { squish(); bubble('Quack!', 1200); }
        return;
      }
      const pick = bridge.current.onPick;   // a page (the landing) decides what a click on a part does
      if (pick) {
        if (h === 'petting' || h === 'body') { squish(); bubble('Quack!', 1200); }
        if (h && h !== 'body') pick(h);
        return;
      }
      if (!h) { if (live.current.focus) live.current.setFocus(null); return; }
      if (h === 'petting' || h === 'body') {
        squish(); bubble('Quack!', 1200);
        bridge.current.onPet?.();
        if (h === 'petting') live.current.setFocus('petting');
        return;
      }
      live.current.setFocus(h);
    };
    const onKey = (e) => { if (e.key === 'Escape' && !bridge.current.onPick) live.current.setFocus(null); };
    const onResize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);

    // ── loop ────────────────────────────────────────────────────────────────
    const timer = new THREE.Timer();
    const G = { cam: new THREE.Vector3(), target: new THREE.Vector3() };
    const tmp = new THREE.Vector3(), tmpN = new THREE.Vector3(), center = new THREE.Vector3();
    const goalEuler = new THREE.Euler(), goalQuat = new THREE.Quaternion();
    const HEAD = new THREE.Vector3(0, 1.15, 0.3);   // head centre in the duck's own space
    const lookPlane = new THREE.Plane(), lookAt = new THREE.Vector3(), toCam = new THREE.Vector3();

    // Hero: turn toward the pointer. Cast a ray through the pointer onto a plane between
    // the duck and the camera, then aim at that point: straight ahead when the pointer is
    // on the duck, turned toward it everywhere else. The body takes part of the turn, the
    // head the rest (and all of the up/down).
    const heroLook = () => {
      if (!c.pointer.known) { c.look.body = c.look.neckYaw = c.look.neckPitch = 0; return; }
      toCam.copy(camera.position).sub(HEAD).normalize();
      lookPlane.setFromNormalAndCoplanarPoint(toCam, lookAt.copy(HEAD).addScaledVector(toCam, 2.2));
      ndc.set((c.pointer.x / window.innerWidth) * 2 - 1, -(c.pointer.y / window.innerHeight) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(lookPlane, lookAt)) return;
      lookAt.sub(HEAD);
      const yaw = Math.atan2(lookAt.x, lookAt.z);
      const pitch = -Math.atan2(lookAt.y, Math.hypot(lookAt.x, lookAt.z));
      c.look.body = clamp(yaw * 0.65, -1.1, 1.1);
      c.look.neckYaw = clamp(yaw - c.look.body, -0.6, 0.6);
      c.look.neckPitch = clamp(pitch, -0.5, 0.45);
    };
    let raf;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      timer.update();
      const dt = Math.min(timer.getDelta(), 0.05);
      const t = timer.getElapsed();
      const now = performance.now();
      const W = window.innerWidth, Hh = window.innerHeight;
      const wide = W >= WIDE;
      const { mode: m, focus: f } = live.current;
      const S = c.S;

      // goals
      const preset = PRESETS[(m === 'dashboard' ? 'dashboard' : 'hero') + (wide ? '' : 'Narrow')];
      let gYaw, gPitch, gOffX = 0, gOffY = 0, gLabels = 0;
      G.cam.set(...preset.cam);
      G.target.set(...preset.target);
      const spot = f && HOTSPOTS.find((h) => h.id === f);

      if (m === 'hero') {
        heroLook();
        gYaw = nearest(preset.yaw, S.yaw) + c.look.body;
        gPitch = preset.pitch;
        gOffX = wide ? 0.25 : 0;
        gOffY = wide ? 0 : 0.2;
        c.userYaw = S.yaw;
      } else if (spot) {
        const [nx, ny, nz] = spot.normal;
        gYaw = nearest(Math.atan2(-nx, nz), c.userYaw);
        gPitch = spot.focusPitch ?? clamp(Math.atan2(ny, Math.hypot(nx, nz)) * 0.92, -0.35, 1.3);
        c.userYaw = gYaw; c.userPitch = gPitch;
        goalQuat.setFromEuler(goalEuler.set(gPitch, gYaw, 0));
        tmp.set(...spot.pos).applyQuaternion(goalQuat);
        G.target.copy(tmp);
        G.cam.copy(tmp).add(tmpN.set(0, 0.3, wide ? 4.4 : 12));
        gOffX = wide ? PANEL_W / 2 / W : 0;
        gOffY = wide ? 0 : 0.3;   // above the bottom sheet
      } else {
        if (!c.drag) {   // inertia, then a gentle idle sway
          c.userYaw += c.yawVel * dt;
          c.yawVel *= Math.exp(-dt * 3.5);
        }
        const idle = reduced ? 0 : clamp((t - c.lastInput - 2.5) / 2, 0, 1);
        gYaw = c.userYaw + Math.sin(t * 0.35) * 0.28 * idle;
        gPitch = c.userPitch;
        if (ASIDE.has(f)) { gOffX = wide ? PANEL_W / 2 / W : 0; gOffY = wide ? 0 : 0.3; }
        else gLabels = 1;
      }

      // landing page: keep turning while you scroll inside a section (p = -0.5..0.5)
      const sc = reduced ? null : bridge.current.scroll;
      if (sc) {
        sc.v *= Math.exp(-6 * dt);
        gYaw += sc.p * 0.7;
        gPitch += sc.p * 0.12;
      }

      // ease toward goals
      const k = (rate) => 1 - Math.exp(-dt * (reduced ? rate * 3 : rate));
      const a = k(3.2);
      S.cam.lerp(G.cam, a);
      S.target.lerp(G.target, a);
      S.offX += (gOffX - S.offX) * a;
      S.offY += (gOffY - S.offY) * a;
      S.yaw += (gYaw - S.yaw) * k(c.drag ? 22 : m === 'hero' ? 5 : 3.4);
      S.pitch += (gPitch - S.pitch) * k(c.drag ? 22 : 3.4);
      S.labels += (gLabels - S.labels) * k(6);

      camera.position.copy(S.cam);
      camera.lookAt(S.target);
      camera.setViewOffset(W, Hh, S.offX * W, S.offY * Hh, W, Hh);
      camera.updateProjectionMatrix();

      // intro pop
      c.intro = Math.min(1, c.intro + dt / (reduced ? 0.2 : 1.1));
      duck.group.scale.setScalar(Math.max(0.001, easeOutBack(c.intro)));
      // elastic snap-back after dragging while a tab is open: under-damped spring = a little overshoot
      const e = c.elastic;
      if (!c.drag) {
        const K = 60, D = reduced ? 2 * Math.sqrt(K) : 7;
        e.vy += (-K * e.yaw - D * e.vy) * dt;  e.yaw += e.vy * dt;
        e.vp += (-K * e.pitch - D * e.vp) * dt;  e.pitch += e.vp * dt;
        if (Math.abs(e.yaw) + Math.abs(e.pitch) + Math.abs(e.vy) + Math.abs(e.vp) < 1e-4) e.yaw = e.pitch = e.vy = e.vp = 0;
      }
      duck.group.rotation.set(S.pitch + e.pitch, S.yaw + e.yaw, 0);

      // springs & idle life
      c.squishV += (-160 * c.squish - 10 * c.squishV) * dt;
      c.squish += c.squishV * dt;
      const s = 1 + c.squish * 0.45;
      duck.squash.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));
      if (c.hopV || c.hopY > 0) {
        c.hopV -= 9.8 * dt;
        c.hopY = Math.max(0, c.hopY + c.hopV * dt);
        if (c.hopY === 0 && c.hopV < 0) c.hopV = 0;
      }
      duck.bob.position.y = (reduced ? 0 : Math.sin(t * 1.5) * 0.035) + c.hopY;
      // afloat: rock gently with the water
      duck.bob.rotation.z = c.water && !reduced ? Math.sin(t * 1.1) * 0.035 : 0;
      duck.bob.rotation.x = c.water && !reduced ? Math.sin(t * 0.8 + 1) * 0.025 : 0;
      if (sc) {   // lean into the scroll; scroll fast and it splashes
        duck.bob.rotation.x += clamp(sc.v * 0.004, -0.18, 0.18);
        duck.bob.rotation.z += clamp(-sc.v * 0.0015, -0.08, 0.08);
        if (Math.abs(sc.v) > 120 && t > c.nextScrollSplash) { c.splash = Math.max(c.splash, 0.05); c.nextScrollSplash = t + 0.45; }
      }

      acc.update(dt, t);

      // water ripples: splash on pats and landings, rings from the beak while talking, idle bobbing
      water.update(t);
      if (c.water) {
        if (c.hopY > 0.05) c.airborne = true;
        else if (c.airborne && c.hopY === 0) { c.airborne = false; c.splash = Math.max(c.splash, 0.08); }
        if (c.splash) { water.ripple(duck.group.position.x, duck.group.position.z, c.splash, 1.0); c.splash = 0; }
        if (c.talk > 0 && t > c.nextVoiceRip) {
          const beak = tmp.set(0, 1.0, 1.35).applyMatrix4(duck.group.matrixWorld);
          water.ripple(beak.x, beak.z, 0.032, 0.05);
          c.nextVoiceRip = t + 0.32;
        }
        if (!reduced && t > c.nextIdleRip) {
          water.ripple(duck.group.position.x, duck.group.position.z, 0.012, 1.05);
          c.nextIdleRip = t + 2.2 + Math.random() * 1.5;
        }
      }

      const lookX = m === 'hero' ? c.look.neckYaw : 0;
      const lookY = m === 'hero' ? c.look.neckPitch : (reduced ? 0 : Math.sin(t * 0.7) * 0.04);
      c.shake = Math.max(0, c.shake - dt * 1.1);
      duck.neck.rotation.y += (lookX + Math.sin(t * 26) * 0.32 * c.shake ** 2 - duck.neck.rotation.y) * k(10);
      duck.neck.rotation.x += (lookY - duck.neck.rotation.x) * k(6);
      duck.neck.rotation.z = reduced ? 0 : Math.sin(t * 0.9) * 0.035;

      c.talk = Math.max(0, c.talk - dt);
      const jawGoal = c.talk > 0 ? (Math.sin(t * 24) * 0.5 + 0.5) * 0.32 : 0;
      duck.jaw.rotation.x += (jawGoal - duck.jaw.rotation.x) * k(25);

      if (t > c.nextBlink) { c.blink = 0.14; c.nextBlink = t + 2.5 + Math.random() * 4; }
      c.blink = Math.max(0, c.blink - dt);
      duck.eyes[0].scale.y = c.blink > 0 ? 0.12 : 1;   // the camera eye never blinks

      c.lens = Math.max(0, c.lens - dt * 0.35);
      duck.lensMaterial.emissiveIntensity = c.lens * 3;   // whole lens glows red on a sentry alert
      duck.recMaterial.emissiveIntensity = f === 'camera' ? 2 + 1.5 * Math.sin(t * 5) : 0.6;   // 'recording' light
      c.ring = Math.max(0, c.ring - dt * 0.9);
      duck.ringMaterial.emissiveIntensity = 0.25 + c.ring * 2.5 + (f === 'petting' ? 0.6 + 0.4 * Math.sin(t * 3) : 0);

      duck.ripples.forEach((r, i) => {
        const start = c.ripples[i];
        const life = start ? t - start : -1;
        if (life < 0 || life > 1.3) { r.material.opacity = 0; return; }
        r.scale.setScalar(1 + life * 4);
        r.material.opacity = (1 - life / 1.3) * 0.85;
      });

      renderer.render(scene, camera);

      // ── HTML overlays: labels, leader lines, speech bubble ─────────────────
      duck.group.updateMatrixWorld();
      const proj = (v) => { const p = v.clone().project(camera); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * Hh]; };
      const [cx] = proj(center.set(0, 0.45, 0).applyMatrix4(duck.group.matrixWorld));
      const top = proj(tmp.set(0, 1.85, 0).applyMatrix4(duck.group.matrixWorld))[1];
      const bottom = proj(tmp.set(0, -0.9, 0).applyMatrix4(duck.group.matrixWorld))[1];
      const duckH = Math.abs(bottom - top);
      const reach = duckH * 0.42;
      bridge.current.duckRect = { x: cx - duckH * 0.45, y: Math.min(top, bottom), w: duckH * 0.9, h: duckH };

      for (const h of HOTSPOTS) {
        const el = labelRefs.current[h.id], line = lineRefs.current[h.id], dot = dotRefs.current[h.id];
        if (!el || !line || !dot) continue;
        const wp = tmp.set(...h.pos).applyMatrix4(duck.group.matrixWorld);
        tmpN.set(...h.normal).normalize().applyQuaternion(duck.group.quaternion);
        const facing = tmpN.dot(center.copy(camera.position).sub(wp).normalize());
        const alpha = clamp((facing - 0.02) / 0.3, 0, 1) * S.labels;
        const [sx, sy] = proj(wp);
        let side = c.sides[h.id] ?? (sx < cx ? -1 : 1);
        if (side === -1 && sx > cx + 14) side = 1;
        if (side === 1 && sx < cx - 14) side = -1;
        c.sides[h.id] = side;
        const lx = cx + side * Math.max(Math.abs(sx - cx) + 70, reach);
        const ly = clamp(sy + (LABEL_DY[h.id] ?? 0) * duckH, 100, Hh - 130);
        const lw = el.offsetWidth || 120;
        const lxMax = side === 1 ? W - lw - 24 : lw + 24;
        const lxc = side === 1 ? Math.min(lx, lxMax) : Math.max(lx, lxMax);
        const ex = lxc - side * 28;
        line.setAttribute('points', `${sx},${sy} ${ex},${ly} ${lxc},${ly}`);
        line.style.opacity = alpha;
        dot.setAttribute('cx', sx); dot.setAttribute('cy', sy);
        dot.style.opacity = alpha;
        el.style.opacity = alpha;
        el.style.pointerEvents = alpha > 0.4 ? 'auto' : 'none';
        el.style.transform = `translate(${side === 1 ? lxc + 8 : lxc - 8}px, ${ly}px) translate(${side === 1 ? '0' : '-100%'}, -50%)`;
      }

      const b = bubbleRef.current;
      if (b) {
        const [bx, by] = proj(tmp.set(0.15, 1.3, 1.25).applyMatrix4(duck.group.matrixWorld));
        b.style.transform = `translate(${bx + 18}px, ${by - 18}px) translate(0, -100%)`;
        b.style.opacity = now < c.bubbleUntil ? 1 : 0;
      }
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      scene.traverse((o) => {
        o.geometry?.dispose();
        [].concat(o.material ?? []).forEach((mt) => { mt.map?.dispose(); mt.dispose(); });
      });
      disposed = true;
      for (const e of loaded.values()) { e.tex.dispose(); e.env.dispose(); }
      scene.environment?.dispose();
      pmrem.dispose();
      renderer.dispose();
      mount.removeChild(canvas);
      bridge.current.react = () => {};
      ctrl.current = null;
    };
  }, [bridge]);

  const interactive = mode === 'dashboard' && !focus;
  return (
    <>
      {/* the scene's small preview, blurred, until its HDR panorama has loaded (the canvas is transparent till then) */}
      <div className="duck-backdrop" style={{ backgroundImage: `url(/scenes/${sceneById(sceneId).file}.jpg)` }} aria-hidden />
      <div ref={mountRef} className="duck-stage" />
      <div className={`duck-overlay ${focus ? 'drawer-open' : ''}`} aria-hidden={!interactive}>
        <svg className="duck-leaders">
          {HOTSPOTS.map((h) => (
            <g key={h.id}>
              <polyline ref={(el) => (lineRefs.current[h.id] = el)} />
              <circle ref={(el) => (dotRefs.current[h.id] = el)} r="5" />
            </g>
          ))}
        </svg>
        {HOTSPOTS.map((h) => (
          <button
            key={h.id}
            ref={(el) => (labelRefs.current[h.id] = el)}
            className="duck-label"
            data-id={h.id}
            tabIndex={interactive ? 0 : -1}
            onClick={() => (bridge.current.onPick ? bridge.current.onPick(h.id) : setFocus(h.id))}
          >
            <span className="duck-label-title">{h.title}</span>
            <span className="duck-label-sub">{badges[h.id] ?? h.sub}</span>
          </button>
        ))}
        <div ref={bubbleRef} className="duck-bubble" role="status" />
      </div>
    </>
  );
}
