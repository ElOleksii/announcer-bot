import type { Logger } from '../logger.js';

/** Plays one file to completion. Resolves when playback ends (or is skipped). */
export interface AudioSink {
  play(file: string, volume: number): Promise<void>;
}

export interface QueueItem {
  file: string;
  volume: number;
  label: string;
}

export interface PlaybackQueueOptions {
  /** Waiting items kept besides the one currently playing; older ones are dropped. */
  maxPending?: number;
  logger?: Logger;
}

/** Sequential playback: sounds never overlap, and a backlog never builds up. */
export class PlaybackQueue {
  private readonly pending: QueueItem[] = [];
  private playing: QueueItem | null = null;
  private readonly maxPending: number;
  private readonly log: Logger | undefined;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly sink: AudioSink,
    options: PlaybackQueueOptions = {},
  ) {
    this.maxPending = options.maxPending ?? 2;
    this.log = options.logger?.child({ module: 'queue' });
  }

  enqueue(item: QueueItem): void {
    this.pending.push(item);
    while (this.pending.length > this.maxPending) {
      const dropped = this.pending.shift();
      this.log?.debug({ dropped: dropped?.label }, 'queue full, dropping oldest sound');
    }
    void this.pump();
  }

  get size(): number {
    return this.pending.length + (this.playing ? 1 : 0);
  }

  /** Resolves once nothing is playing or waiting. */
  whenIdle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  clear(): void {
    this.pending.length = 0;
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    while (this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.playing = item;
      try {
        this.log?.debug({ sound: item.label, file: item.file }, 'playing');
        await this.sink.play(item.file, item.volume);
      } catch (err) {
        this.log?.error({ err, sound: item.label }, 'playback failed');
      } finally {
        this.playing = null;
      }
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
