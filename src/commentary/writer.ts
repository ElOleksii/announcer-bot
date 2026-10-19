import type { KillContext } from './context.js';

/** Turns a kill context into one short line of commentary. */
export interface CommentaryWriter {
  readonly name: string;
  write(ctx: KillContext, signal?: AbortSignal): Promise<string>;
}

/** Turns text into an audio file the playback queue can play. */
export interface SpeechSynthesizer {
  readonly name: string;
  /** Returns the path of an audio file with the spoken text. */
  synthesize(text: string, signal?: AbortSignal): Promise<string>;
}
