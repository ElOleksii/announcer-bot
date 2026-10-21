import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { MATCH_RESULT_SOUNDS, MULTIKILL_SOUNDS, type SoundKey } from '../game/events.js';
import { ConfigError } from './env.js';

/** 0 = mute, 1 = original, 2 = +6 dB. */
const volume = z.number().min(0).max(2);

/** A file name, or a file with its own volume (multiplied by the master volume). */
const soundEntrySchema = z.union([
  z.string().min(1),
  z.object({ file: z.string().min(1), volume: volume.default(1) }),
]);

const soundsFileSchema = z.object({
  /** Master volume, applied to every sound. */
  volume: volume.default(1),
  /** Folder with audio files, relative to the config file. */
  soundsDir: z.string().default('sounds'),
  /** kill_streak value → sound key. */
  streaks: z
    .record(z.string().regex(/^[1-9]\d*$/, 'streak keys must be positive integers'), z.string().min(1))
    .default({}),
  /** Sound key → candidate files; one is picked at random. */
  events: z.record(z.string().min(1), z.array(soundEntrySchema)),
});

export interface SoundFile {
  /** Absolute path of a file that exists on disk. */
  path: string;
  /** Final volume: master volume × the file's own volume. */
  volume: number;
}

export interface SoundsConfig {
  streakThresholds: Record<number, SoundKey>;
  events: Record<SoundKey, SoundFile[]>;
  /** Events the announcer can emit that have no playable file of their own. */
  withoutSound: SoundKey[];
  warnings: string[];
}

/** Every key the announcer can emit with the given streak thresholds. */
export function knownSoundKeys(streakThresholds: Record<number, SoundKey>): SoundKey[] {
  return [
    ...new Set([
      'kill',
      ...Object.values(MULTIKILL_SOUNDS),
      ...Object.values(streakThresholds),
      'death',
      ...Object.values(MATCH_RESULT_SOUNDS),
    ]),
  ];
}

export function loadSoundsConfig(path: string): SoundsConfig {
  const configPath = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read sounds config ${configPath}: ${(err as Error).message}`);
  }

  const result = soundsFileSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid sounds config ${configPath}:\n${z.prettifyError(result.error)}`);
  }
  const file = result.data;

  const soundsDir = resolve(dirname(configPath), file.soundsDir);
  const warnings: string[] = [];
  const events: Record<SoundKey, SoundFile[]> = {};

  for (const [key, entries] of Object.entries(file.events)) {
    events[key] = entries
      .map((entry) => (typeof entry === 'string' ? { file: entry, volume: 1 } : entry))
      .map((entry) => ({
        path: isAbsolute(entry.file) ? entry.file : resolve(soundsDir, entry.file),
        volume: round(file.volume * entry.volume),
      }))
      .filter((sound) => {
        if (existsSync(sound.path)) return true;
        warnings.push(`sound file for "${key}" not found: ${sound.path}`);
        return false;
      });
  }

  const streakThresholds = Object.fromEntries(Object.entries(file.streaks).map(([k, v]) => [Number(k), v]));

  const withoutSound = knownSoundKeys(streakThresholds).filter((key) => !events[key]?.length);

  return { streakThresholds, events, withoutSound, warnings };
}

/** Avoid 0.8 * 1.1 = 0.8800000000000001 leaking into logs and ffmpeg arguments. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
