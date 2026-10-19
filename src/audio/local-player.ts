import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import { commandExists, run, transcodeToWav } from './ffmpeg.js';
import type { AudioSink } from './playback-queue.js';

type Backend = 'ffplay' | 'afplay' | 'powershell' | 'paplay' | 'aplay';

const PLAY_TIMEOUT_MS = 30_000;

/** Plays sounds on this PC (PLAYBACK_MODE=local). Picks the first available player. */
export class LocalAudioSink implements AudioSink {
  private readonly cacheDir = join(tmpdir(), 'dota-kill-announcer');

  private constructor(
    readonly backend: Backend,
    private readonly log: Logger,
  ) {}

  static detect(logger: Logger): LocalAudioSink {
    const log = logger.child({ module: 'local-audio' });
    const backend = detectBackend();
    if (!backend) {
      throw new Error('No local audio player found. Install ffplay (comes with FFmpeg), or pulseaudio-utils / alsa-utils on Linux.');
    }
    log.info({ backend }, 'local playback ready');
    return new LocalAudioSink(backend, log);
  }

  async play(file: string, volume: number): Promise<void> {
    switch (this.backend) {
      case 'ffplay':
        return run('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', '-af', `volume=${volume.toFixed(3)}`, file], {
          timeoutMs: PLAY_TIMEOUT_MS,
        });
      case 'afplay':
        return run('afplay', ['-v', String(volume), file], { timeoutMs: PLAY_TIMEOUT_MS });
      case 'powershell': {
        const wav = await this.toWav(file, volume);
        // Path is passed via the environment to avoid any quoting issues.
        return run(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', '(New-Object System.Media.SoundPlayer $env:KILL_ANNOUNCER_WAV).PlaySync()'],
          { timeoutMs: PLAY_TIMEOUT_MS, env: { ...process.env, KILL_ANNOUNCER_WAV: wav } },
        );
      }
      case 'paplay':
      case 'aplay': {
        const wav = await this.toWav(file, volume);
        return run(this.backend, [wav], { timeoutMs: PLAY_TIMEOUT_MS });
      }
    }
  }

  /** WAV copy with volume baked in, cached by source path, mtime and volume. */
  private async toWav(file: string, volume: number): Promise<string> {
    const key = createHash('sha1').update(`${file}|${statSync(file).mtimeMs}|${volume}`).digest('hex').slice(0, 16);
    const target = join(this.cacheDir, `${key}.wav`);
    if (!existsSync(target)) {
      mkdirSync(this.cacheDir, { recursive: true });
      this.log.debug({ file, target }, 'transcoding to wav');
      await transcodeToWav(file, volume, target);
    }
    return target;
  }
}

function detectBackend(): Backend | null {
  if (commandExists('ffplay')) return 'ffplay';
  switch (process.platform) {
    case 'win32':
      return 'powershell';
    case 'darwin':
      return 'afplay';
    default:
      if (commandExists('paplay', '--version')) return 'paplay';
      if (commandExists('aplay', '--version')) return 'aplay';
      return null;
  }
}
