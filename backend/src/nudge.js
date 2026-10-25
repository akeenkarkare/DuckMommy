// Coach lines from Claude: kind + facts in, one short spoken sentence or two out.
// Called by the relay's POST /nudge. Plain fetch to the Messages API, no SDK.

const API_URL = `${(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
const TIMEOUT_MS = 7000;
const MAX_CHARS = 220;

const TONES = {
  gentle: 'Warm and encouraging, like a kind friend. Never pushy.',
  coach: 'A confident coach who believes in them: direct, upbeat, a little playful. Push, but kindly.',
  savage: 'A funny, roasting best friend. Tease the procrastination, never the person: nothing about looks, body, intelligence or worth. Still ends with a push to act.',
};

const KINDS = {
  arrival: 'They just sat down. The duck has ALREADY said "welcome back", so do not greet them again. Tell them the most urgent thing coming up and get them to start on it now.',
  deadline: 'Something is due soon (see item). Make the time left feel real and get them to start the next small piece now.',
  event: 'An event starts soon (see item). Tell them to wrap up and get ready.',
  checkin: 'Periodic check-in while they work. Get them to commit to one specific task for the next stretch. If something is due soon, tie it to that.',
  idle: 'They have not moved for several minutes; they may have zoned out or be scrolling. Snap them back gently, with a tiny next step.',
  focus_start: 'They just started a focus session (focus_minutes). Hype them up in one line and promise to stay quiet.',
  focus_done: 'A focus session just ended (worked_minutes). Celebrate it and tell them to take a short break.',
  break_start: 'They are starting a break (break_minutes). Tell them to really rest and that you will call them back.',
  break_over: 'Their break is over. Get them back into it.',
  finish: 'They are done for now (worked_minutes may be set). Short, proud sign-off.',
  more_time: 'They asked for more time in the focus session (added_minutes, left_minutes). Confirm it.',
  time_left: 'They asked how much time is left (left_minutes; null means no session is running, so suggest starting one).',
};

export function buildPrompt({ kind, tone, facts, name }) {
  const style = TONES[tone] ?? TONES.coach;
  const job = KINDS[kind] ?? KINDS.checkin;
  const system = [
    'You are Duck Mommy, a rubber duck that sits on a student\'s desk and talks out loud through a speaker.',
    'You are their accountability buddy: you help them lock in and get their work done, like the future version of themselves who is glad they started early.',
    'Persuade with: the real deadline and time left, one concrete next step they can do in the next minute, and the payoff of getting it done. No guilt trips, no lecturing.',
    `Tone: ${style}`,
    'Rules: reply with ONLY the words the duck says. One or two short sentences, at most 30 words. It is read aloud by text-to-speech, so no emoji, no markdown, no lists, no quotation marks, no stage directions.',
    'Only mention assignments, events, times and numbers that appear in the facts. Never invent deadlines. Say times in natural words ("in about three hours", "tomorrow"), not timestamps or minute counts over 90.',
    name ? `Their name is ${name}. Use it at most occasionally.` : '',
  ].filter(Boolean).join('\n');
  const user = `Situation: ${job}\nFacts (JSON): ${JSON.stringify(facts ?? {})}\nWrite the line.`;
  return { system, user };
}

/** Make a model reply safe to speak: one line, no quotes/markdown/emoji, bounded length. */
export function cleanLine(text) {
  let t = String(text ?? '')
    .replace(/[*_#`>]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^(duck( mommy| daddy)?|assistant)\s*:\s*/i, '')
    .trim();
  if (t.length > MAX_CHARS) {
    const cut = t.slice(0, MAX_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = end > 15 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '.';
  }
  return t;
}

export async function writeNudge({ apiKey, model, kind, tone, facts, name, fetchImpl = fetch }) {
  const { system, user } = buildPrompt({ kind, tone, facts, name });
  const r = await fetchImpl(API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 120, temperature: 1, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return cleanLine(text);
}
