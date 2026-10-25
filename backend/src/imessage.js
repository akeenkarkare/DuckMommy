// Sentry alerts by iMessage, through Photon Spectrum (spectrum-ts, cloud iMessage lines).
//
//   relay sees a confirmed sentry event --> sendIMessage(user's profiles.phone, same text as the
//   dashboard's "Possible intruder" notification) --> Photon --> the owner's phone.
//
// Needs SPECTRUM_PROJECT_ID + SPECTRUM_PROJECT_SECRET (Photon dashboard) in backend/.env. The number
// is the active user's profiles.phone (register form / Sentry panel), else SENTRY_IMESSAGE_TO.
// Without credentials, a number, or the package, it stays off.

// Same words as dashboard/components/IntruderAlert.js raiseIntruderAlarm(): keep the two in sync.
export const SENTRY_TITLE = '🚨 Possible intruder at your desk';
export const SENTRY_BODY = 'The duck spotted someone while sentry mode is on. Open the dashboard to watch the feed.';
export const sentryText = () => `${SENTRY_TITLE}\n${SENTRY_BODY}`;

export function imessageConfigured(env) {
  return !!(env.SPECTRUM_PROJECT_ID && env.SPECTRUM_PROJECT_SECRET);
}

let appPromise = null;   // one Spectrum connection for the life of the relay
const spaces = new Map(); // phone -> DM space

async function connect(env) {
  const { Spectrum } = await import('spectrum-ts');
  const { imessage } = await import('spectrum-ts/providers/imessage');
  const app = await Spectrum({
    projectId: env.SPECTRUM_PROJECT_ID,
    projectSecret: env.SPECTRUM_PROJECT_SECRET,
    providers: [imessage.config()],   // discovers the project's lines and renews their tokens
  });
  return { app, imessage };
}

/** Text `to` (E.164). Throws on failure; the caller logs it. */
export async function sendIMessage(env, to, text) {
  appPromise ??= connect(env).catch((e) => { appPromise = null; throw e; });
  const { app, imessage } = await appPromise;
  let dm = spaces.get(to);
  if (!dm) {
    const im = imessage(app);
    dm = await im.space.create(await im.user(to));
    spaces.set(to, dm);
  }
  try {
    await dm.send(text);
  } catch (e) {
    spaces.delete(to);   // a stale space: look it up again next time
    throw e;
  }
}
