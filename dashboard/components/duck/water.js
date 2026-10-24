import * as THREE from 'three';

// The water the duck floats on, in every scene. A flat plane out to the horizon whose
// per-pixel normals come from a height field: a faint calm-water shimmer + up to
// MAX_RIPPLES expanding rings from the duck (voice, pats, bobbing) - the ripples are the point.
// Built on MeshPhysicalMaterial so it reflects the scene's HDR panorama (sky, sun, rocks).

const MAX_RIPPLES = 8;
export const WATER_Y = -0.4;   // the duck floats with its lower body under water

export function buildWater() {
  const uniforms = {
    uTime: { value: 0 },
    uRip: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -100, 0)) },   // x, z, start, amp
    uRipR: { value: new Array(MAX_RIPPLES).fill(0) },   // radius the ring starts at
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: '#22a7bd', roughness: 0.05, metalness: 0, ior: 1.33, clearcoat: 0.3,
    transparent: true, envMapIntensity: 1.1,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform float uTime;
uniform vec4 uRip[${MAX_RIPPLES}];
uniform float uRipR[${MAX_RIPPLES}];

float waterH(vec2 p) {
  // calm water: a barely-there shimmer that fades with distance (no sparkle noise far away)
  float calm = 1.0 / (1.0 + length(p) * 0.25);
  float h = calm * (
      0.0025 * sin(dot(p, vec2(0.8, 0.3)) * 2.6 + uTime * 1.1)
    + 0.0015 * sin(dot(p, vec2(-0.45, 0.9)) * 3.9 + uTime * 1.4));
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRip[i];
    float age = uTime - r.z;
    if (r.w <= 0.0 || age < 0.0 || age > 7.0) continue;
    float d = distance(p, r.xy);
    float x = d - (uRipR[i] + age * 1.4);              // distance behind the ring front
    float env = exp(-x * x * 2.2) * exp(-age * 0.55) / (1.0 + d * 0.35);
    h += r.w * env * sin(x * 13.0);
  }
  return h;
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float e = 0.025;
  vec2 p = vWPos.xz;
  float hx = (waterH(p + vec2(e, 0.0)) - waterH(p - vec2(e, 0.0))) / (2.0 * e);
  float hz = (waterH(p + vec2(0.0, e)) - waterH(p - vec2(0.0, e))) / (2.0 * e);
  vec3 nWorld = normalize(vec3(-hx * 2.2, 1.0, -hz * 2.2));
  normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
}`)
      // see-through only right around the duck (its submerged half); solid everywhere else,
      // so none of the panorama's ground shows below the horizon
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
gl_FragColor.a = mix(0.82, 1.0, smoothstep(1.4, 2.6, length(vWPos.xz)));`);
  };

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), material);   // to the horizon
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = WATER_Y;
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;   // after the duck, so the submerged half shows through tinted

  let next = 0;
  return {
    mesh,
    uniforms,
    /** A ring at world (x, z), starting at radius r0. */
    ripple(x, z, amp = 0.03, r0 = 0.1) {
      uniforms.uRip.value[next].set(x, z, uniforms.uTime.value, amp);
      uniforms.uRipR.value[next] = r0;
      next = (next + 1) % MAX_RIPPLES;
    },
    update(t) {
      uniforms.uTime.value = t;
    },
    /** Tint per scene, so the water matches the panorama's colours. */
    setColor(color) {
      material.color.set(color);
    },
  };
}
