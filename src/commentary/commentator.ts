import type { Logger } from '../logger.js';
import type { KillContext } from './context.js';
import type { CommentaryWriter, SpeechSynthesizer } from './writer.js';

export interface SpokenLine {
  text: string;
  file: string;
}

export interface CommentatorOptions {
  writer: CommentaryWriter;
  /** Used when `writer` fails (API down, quota exceeded…). */
  fallbackWriter: CommentaryWriter;
  synthesizer: SpeechSynthesizer;
  /** Whole budget for text + speech; after that the line is dropped. */
  timeoutMs: number;
  logger: Logger;
}

/** Writes a line about a kill and turns it into audio, within a time budget. */
export class Commentator {
  private readonly log: Logger;

  constructor(private readonly options: CommentatorOptions) {
    this.log = options.logger.child({ module: 'commentator' });
  }

  get description(): string {
    return `${this.options.writer.name} + ${this.options.synthesizer.name}`;
  }

  /** Returns null when nothing could be produced in time; the caller then falls back to a sound. */
  async comment(ctx: KillContext): Promise<SpokenLine | null> {
    return this.withTimeout(async (signal) => {
      const text = await this.writeLine(ctx, signal);
      this.log.info({ text }, 'commentary');
      return { text, file: await this.options.synthesizer.synthesize(text, signal) };
    });
  }

  /** Speaks arbitrary text (for /say). */
  async say(text: string): Promise<SpokenLine | null> {
    return this.withTimeout(async (signal) => ({ text, file: await this.options.synthesizer.synthesize(text, signal) }));
  }

  private async writeLine(ctx: KillContext, signal: AbortSignal): Promise<string> {
    try {
      return await this.options.writer.write(ctx, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      this.log.warn({ err: (err as Error).message, writer: this.options.writer.name }, 'writer failed, using fallback lines');
      return this.options.fallbackWriter.write(ctx, signal);
    }
  }

  private async withTimeout(task: (signal: AbortSignal) => Promise<SpokenLine>): Promise<SpokenLine | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${this.options.timeoutMs}ms`)), this.options.timeoutMs);
    try {
      return await task(controller.signal);
    } catch (err) {
      const reason = controller.signal.aborted ? String(controller.signal.reason) : (err as Error).message;
      this.log.warn({ err: reason }, 'commentary failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
