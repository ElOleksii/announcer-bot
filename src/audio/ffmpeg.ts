import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';

export function ffmpegBinary(): string {
  // ffmpeg-static ships a binary for the current platform; fall back to ffmpeg on PATH.
  return (ffmpegStatic as unknown as string | null) ?? 'ffmpeg';
}

function volumeFilter(volume: number): string[] {
  return ['-af', `volume=${volume.toFixed(3)}`];
}

/**
 * Transcodes any audio file to 48 kHz stereo Ogg/Opus on stdout, with volume applied.
 * @discordjs/voice can send these Opus packets as-is, so no Opus encoder library is needed.
 */
export function spawnOggOpus(file: string, volume: number): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(
    ffmpegBinary(),
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', file,
      ...volumeFilter(volume),
      '-ac', '2', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', '-application', 'audio',
      '-f', 'ogg', 'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
}

/** Transcodes to 16-bit PCM WAV (for players that only understand WAV). */
export function transcodeToWav(file: string, volume: number, output: string): Promise<void> {
  return run(ffmpegBinary(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', file,
    ...volumeFilter(volume),
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le',
    output,
  ]);
}

/** Runs a process to completion; rejects on non-zero exit or after `timeoutMs`. */
export function run(command: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`));
    });
  });
}

/** True when `command` can be started (exists on PATH). */
export function commandExists(command: string, versionArg = '-version'): boolean {
  const result = spawnSync(command, [versionArg], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
  return !result.error;
}
