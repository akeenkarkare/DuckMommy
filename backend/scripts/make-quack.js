// One-off: generate assets/quack.wav with ElevenLabs sound effects.
//   npm run make-quack            (uses ELEVENLABS_API_KEY from backend/.env)
//   npm run make-quack -- "a deep goofy duck quack"
// The Pi plays this file when the pressure sensor is pressed.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { ELEVENLABS_API_KEY } = process.env;
if (!ELEVENLABS_API_KEY) throw new Error('Missing ELEVENLABS_API_KEY in backend/.env');

const RATE = 22050;
const prompt = process.argv[2] ?? 'a single short cartoon duck quack, close up, no background noise';
const assets = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

const r = await fetch(`https://api.elevenlabs.io/v1/sound-generation?output_format=pcm_${RATE}`, {
  method: 'POST',
  headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ text: prompt, duration_seconds: 1, prompt_influence: 0.6 }),
});
if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${await r.text()}`);

const audio = Buffer.from(await r.arrayBuffer());
mkdirSync(assets, { recursive: true });

if ((r.headers.get('content-type') ?? '').includes('mpeg')) {
  // The API ignored output_format: keep the mp3 and say how to convert it.
  writeFileSync(join(assets, 'quack.mp3'), audio);
  console.log('Got MP3, saved assets/quack.mp3. Convert it: ffmpeg -i assets/quack.mp3 -ar 22050 -ac 1 assets/quack.wav');
} else {
  // Raw 16-bit mono PCM -> WAV
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + audio.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(audio.length, 40);
  writeFileSync(join(assets, 'quack.wav'), Buffer.concat([header, audio]));
  console.log(`Saved assets/quack.wav (${(audio.length / 2 / RATE).toFixed(2)} s)`);
}
