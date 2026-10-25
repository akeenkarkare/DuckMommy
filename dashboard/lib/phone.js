// Phone numbers for sentry iMessage alerts, stored as E.164 (+15551234567) in profiles.phone.
// Accepts what people type: spaces, dashes, dots, brackets; 00 for +; 10 bare digits = US (+1).
const E164 = /^\+[1-9]\d{6,14}$/;

/** '' -> '' (no number), a valid number -> E.164, anything else -> null. */
export function normalizePhone(input) {
  let p = String(input ?? '').replace(/[\s\-.()]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  if (/^\d{10}$/.test(p)) p = `+1${p}`;
  else if (/^1\d{10}$/.test(p)) p = `+${p}`;
  return E164.test(p) ? p : null;
}

export const PHONE_HINT = 'For “possible intruder” iMessages. Include the country code, e.g. +1 555 123 4567.';
