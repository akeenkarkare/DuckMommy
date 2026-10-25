// The duck's hardware, as clickable hotspots. Positions/normals are in the duck's own
// coordinates (it faces +Z, up is +Y). The camera is the duck's right eye (viewer's left).
// normal: which way the part faces (labels fade when it turns away); focusPitch overrides the zoom tilt.
export const HOTSPOTS = [
  { id: 'camera', title: 'Camera', sub: 'Posture · Sentry · Signs', pos: [-0.33, 1.33, 0.86], normal: [-0.49, 0.27, 0.82] },
  { id: 'petting', title: 'Petting', sub: 'Press its head', pos: [0, 1.84, 0.28], normal: [0, 0.6, 0.8], focusPitch: 1.15 },
  { id: 'voice', title: 'Voice', sub: 'What it says', pos: [0, 1.04, 1.34], normal: [0, 0.1, 1] },
  { id: 'microphone', title: 'Microphone', sub: 'Sound alerts', pos: [0, -0.2, 1.1], normal: [0, -0.2, 1] },
  { id: 'focus', title: 'Focus & coach', sub: 'Lock in', pos: [0, 0.65, -0.95], normal: [0, 0.8, -0.58] },
];

export const ACTIVITY = { id: 'activity', title: 'Activity', sub: 'Everything, live' };
export const CALENDAR = { id: 'calendar', title: 'Calendar', sub: 'Deadlines + events' };
export const NEST = { id: 'nest', title: 'Nest', sub: 'What you told it to remember' };

export const byId = (id) => HOTSPOTS.find((h) => h.id === id) ?? [ACTIVITY, CALENDAR, NEST].find((p) => p.id === id) ?? null;
