/**
 * Tries the commentator without Dota or Discord: writes lines for a few sample situations
 * with the configured writer (Gemini or templates) and prints them with timings.
 *
 *   npm run test:commentary              → text only (no ElevenLabs credits used)
 *   npm run test:commentary -- --speak   → also synthesize with ElevenLabs and play on this PC
 *   npm run test:commentary -- --only techies
 */
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { LocalAudioSink } from '../src/audio/local-player.js';
import type { KillContext } from '../src/commentary/context.js';
import { ElevenLabsSynthesizer } from '../src/commentary/elevenlabs.js';
import { GeminiWriter } from '../src/commentary/gemini.js';
import { TemplateWriter } from '../src/commentary/templates.js';
import type { CommentaryWriter } from '../src/commentary/writer.js';
import { ConfigError, loadConfig, loadDotEnv } from '../src/config/env.js';

const base: Omit<KillContext, 'event'> = {
  hero: 'Lina',
  heroLevel: 14,
  kills: 6,
  deaths: 3,
  assists: 9,
  killStreak: 2,
  gameTimeSec: 1325,
  alive: true,
  healthPercent: 64,
  recentCasts: [],
  victims: [],
};

const SAMPLES: Record<string, KillContext> = {
  techies: { ...base, event: { kind: 'kill', sound: 'kill' }, hero: 'Techies', recentCasts: [], victims: [{ slot: '6', timesKilled: 2 }] },
  laguna: {
    ...base,
    event: { kind: 'multikill', count: 2, sound: 'double_kill' },
    recentCasts: ['lina_laguna_blade'],
    killStreak: 3,
  },
  posthumous: { ...base, event: { kind: 'kill', sound: 'kill' }, hero: 'Sniper', alive: false, healthPercent: 0 },
  lowhp: { ...base, event: { kind: 'kill', sound: 'kill' }, hero: 'Pudge', healthPercent: 4, recentCasts: ['pudge_meat_hook'] },
  rampage: {
    ...base,
    event: { kind: 'multikill', count: 5, sound: 'rampage' },
    hero: 'Faceless Void',
    recentCasts: ['faceless_void_chronosphere'],
    killStreak: 9,
  },
  revenge: { ...base, event: { kind: 'kill', sound: 'kill' }, hero: 'Phantom Assassin', victims: [{ slot: '8', timesKilled: 4 }] },
  streak: { ...base, event: { kind: 'streak', streak: 5, sound: 'mega_kill' }, hero: 'Juggernaut', killStreak: 5 },
  death: { ...base, event: { kind: 'death', sound: 'death' }, hero: 'Crystal Maiden', healthPercent: 0, alive: false, killStreak: 0 },
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { speak: { type: 'boolean', default: false }, only: { type: 'string' } } });
  loadDotEnv();
  // Discord settings are irrelevant here; local mode skips their validation.
  const config = loadConfig({ ...process.env, PLAYBACK_MODE: 'local', ANNOUNCER_MODE: 'sounds' });
  const { text, tts } = config.commentary;
  const logger = pino({ level: 'warn' });

  const writer: CommentaryWriter = text.provider === 'gemini' ? new GeminiWriter(text) : new TemplateWriter();
  const speech = values.speak ? (tts ? new ElevenLabsSynthesizer(tts) : null) : null;
  if (values.speak && !speech) throw new ConfigError('--speak needs ELEVENLABS_API_KEY in .env');
  const player = speech ? LocalAudioSink.detect(logger) : null;

  const names = values.only ? [values.only] : Object.keys(SAMPLES);
  console.log(`Writer: ${writer.name}${speech ? ` · voice: ${speech.name}` : ''}\n`);

  for (const name of names) {
    const sample = SAMPLES[name];
    if (!sample) throw new Error(`Unknown sample "${name}". Available: ${Object.keys(SAMPLES).join(', ')}`);
    const started = Date.now();
    try {
      const line = await writer.write(sample, AbortSignal.timeout(15_000));
      const textMs = Date.now() - started;
      let timing = `text ${textMs} ms`;
      if (speech && player) {
        const file = await speech.synthesize(line, AbortSignal.timeout(15_000));
        timing += ` · voice ${Date.now() - started - textMs} ms`;
        console.log(`▶ ${name.padEnd(10)} ${line}\n  ${timing}`);
        await player.play(file, 1);
      } else {
        console.log(`▶ ${name.padEnd(10)} ${line}\n  ${timing}`);
      }
    } catch (err) {
      console.log(`✖ ${name.padEnd(10)} ${(err as Error).message}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exitCode = 1;
});
