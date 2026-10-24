// Background scenes: CC0 HDR panoramas from polyhaven.com (public/scenes, `npm run get-scenes`).
// In every scene the duck floats on open water (water.js) out to the horizon; the panorama
// gives the sky, the backdrop (rocks, trees, ocean) and the lighting, and the water reflects it.
//   water     body colour of the water, picked to match the panorama
//   rot       turns the panorama so the interesting part is behind the duck
export const SCENES = [
  { id: 'pool', label: 'Swimming pool', file: 'pool', water: '#22a7bd', rot: Math.PI / 2, exposure: 0.95 },
  { id: 'pebble', label: 'Pebble beach', file: 'lakeside', water: '#2a6d78', rot: Math.PI / 2, exposure: 0.9 },
  { id: 'stony', label: 'Stony beach', file: 'secluded_beach', water: '#2c6880', rot: Math.PI / 2, exposure: 1.0 },
  { id: 'ocean', label: 'Ocean', file: 'white_cliff_top', water: '#1d4a66', rot: -Math.PI / 2, exposure: 0.9 },
];

export const DEFAULT_SCENE = 'pool';
export const sceneById = (id) => SCENES.find((s) => s.id === id) ?? SCENES[0];
