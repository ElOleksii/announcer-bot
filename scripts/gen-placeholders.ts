/**
 * Generates short, distinguishable placeholder tones for every file listed in sounds.config.json,
 * so the pipeline can be tested before you add real announcer sounds.
 * Existing files are never overwritten unless you pass --force.
 *
 *   npm run gen:sounds
 *   npm run gen:sounds -- --force
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../src/config/env.js';
import { ffmpegBinary, run } from '../src/audio/ffmpeg.js';

interface Tone {
  expr: string;
  duration: number;
}

/** n short beeps at `freq` Hz. */
const beeps = (n: number, freq: number): Tone => ({
  expr: `0.5*sin(2*PI*${freq}*t)*lt(mod(t,0.22),0.14)`,
  duration: n * 0.22,
});

/** Upward chirp; higher streaks start higher. */
const chirp = (start: number): Tone => ({ expr: `0.5*sin(2*PI*(${start}+500*t)*t)`, duration: 0.6 });

const TONES: Record<string, Tone> = {
  kill: beeps(1, 880),
  double_kill: beeps(2, 880),
  triple_kill: beeps(3, 880),
  ultra_kill: beeps(4, 880),
  rampage: beeps(5, 1100),
  killing_spree: chirp(400),
  dominating: chirp(470),
  mega_kill: chirp(540),
  unstoppable: chirp(610),
  wicked_sick: chirp(680),
  monster_kill: chirp(750),
  godlike: chirp(820),
  beyond_godlike: chirp(900),
  death: { expr: '0.5*sin(2*PI*(420-200*t)*t)', duration: 0.8 },
};

const FALLBACK: Tone = beeps(1, 660);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } });
  loadDotEnv();
  const configPath = resolve(process.env.SOUNDS_CONFIG || 'sounds.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { soundsDir?: string; events: Record<string, string[]> };
  const soundsDir = resolve(dirname(configPath), config.soundsDir ?? 'sounds');
  mkdirSync(soundsDir, { recursive: true });

  for (const [key, files] of Object.entries(config.events)) {
    for (const file of files) {
      const target = resolve(soundsDir, file);
      if (existsSync(target) && !values.force) {
        console.log(`skip   ${basename(target)} (exists)`);
        continue;
      }
      const tone = TONES[key] ?? FALLBACK;
      const fade = `afade=t=in:d=0.01,afade=t=out:st=${(tone.duration - 0.05).toFixed(2)}:d=0.05`;
      mkdirSync(dirname(target), { recursive: true });
      await run(ffmpegBinary(), [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `aevalsrc='${tone.expr}':s=48000:d=${tone.duration}`,
        '-af', fade,
        ...(extname(target).toLowerCase() === '.wav' ? ['-c:a', 'pcm_s16le'] : []),
        target,
      ]);
      console.log(`wrote  ${basename(target)}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
