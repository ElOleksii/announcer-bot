import type { PlaybackQueue } from './audio/playback-queue.js';
import type { SoundPicker } from './audio/sound-picker.js';
import type { Commentator } from './commentary/commentator.js';
import type { KillContext } from './commentary/context.js';
import type { SoundFile } from './config/sounds.js';
import { describeEvent, soundChain, type GameEvent, type SoundKey } from './game/events.js';
import type { Logger } from './logger.js';

export const ANNOUNCER_MODES = ['sounds', 'commentator', 'both'] as const;
export type AnnouncerMode = (typeof ANNOUNCER_MODES)[number];

/** Volume for spoken lines, relative to the original TTS loudness. */
const SPEECH_VOLUME = 1;

export interface AnnouncerOptions {
  picker: SoundPicker<SoundFile>;
  queue: PlaybackQueue;
  /** null when no TTS is configured: only "sounds" mode is available. */
  commentator: Commentator | null;
  mode: AnnouncerMode;
  logger: Logger;
}

/**
 * Decides what to play for a game event:
 * - sounds:      a sound file from sounds.config.json
 * - commentator: a generated spoken line; the sound file if that fails or times out
 * - both:        the sound right away, then the spoken line when it is ready
 */
export class Announcer {
  private currentMode: AnnouncerMode;
  private readonly log: Logger;

  constructor(private readonly options: AnnouncerOptions) {
    this.currentMode = options.commentator ? options.mode : 'sounds';
    this.log = options.logger.child({ module: 'announcer' });
  }

  get mode(): AnnouncerMode {
    return this.currentMode;
  }

  get commentatorAvailable(): boolean {
    return this.options.commentator !== null;
  }

  get commentatorDescription(): string | null {
    return this.options.commentator?.description ?? null;
  }

  /** Returns false when the mode needs a commentator that is not configured. */
  setMode(mode: AnnouncerMode): boolean {
    if (mode !== 'sounds' && !this.options.commentator) return false;
    this.currentMode = mode;
    this.log.info({ mode }, 'announcer mode changed');
    return true;
  }

  playSound(keys: readonly SoundKey[], label: string): boolean {
    const sound = this.options.picker.pickFirst(keys);
    if (!sound) {
      this.log.warn({ sounds: keys }, 'no sound file for event');
      return false;
    }
    this.options.queue.enqueue({ file: sound.path, volume: sound.volume, label });
    return true;
  }

  async onEvent(event: GameEvent, ctx: KillContext): Promise<void> {
    const label = describeEvent(event);
    const commentator = this.options.commentator;
    const mode = this.currentMode;

    if (mode === 'sounds' || !commentator) {
      this.playSound(soundChain(event), label);
      return;
    }

    if (mode === 'both') this.playSound(soundChain(event), label);

    const line = await commentator.comment(ctx);
    if (line) {
      this.options.queue.enqueue({ file: line.file, volume: SPEECH_VOLUME, label: `commentary: ${label}` });
    } else if (mode === 'commentator') {
      this.playSound(soundChain(event), label);
    }
  }

  /** Speaks arbitrary text. */
  async say(text: string): Promise<'queued' | 'failed' | 'unavailable'> {
    const commentator = this.options.commentator;
    if (!commentator) return 'unavailable';
    const line = await commentator.say(text);
    if (!line) return 'failed';
    this.options.queue.enqueue({ file: line.file, volume: SPEECH_VOLUME, label: 'say' });
    return 'queued';
  }
}
